import type { CatalogBaseImage } from './types.js';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type DockerfileBaseIssue = {
  kind: 'invalid' | 'missing-digest';
  message: string;
};

type DockerfileBase = {
  alias: string | undefined;
  reference: string;
};

function logicalInstructions(dockerfile: string): string[] {
  const instructions: string[] = [];
  let current = '';

  for (const line of dockerfile.split(/\r?\n/u)) {
    if (current.length === 0 && /^\s*#/u.test(line)) {
      continue;
    }

    const continued = /\\\s*$/u.test(line);
    const segment = line.replace(/\\\s*$/u, '').trim();
    current = current.length === 0 ? segment : `${current} ${segment}`;
    if (!continued && current.length > 0) {
      instructions.push(current.replaceAll(/\s+/gu, ' '));
      current = '';
    }
  }

  if (current.length > 0) {
    instructions.push(current.replaceAll(/\s+/gu, ' '));
  }
  return instructions;
}

function dockerfileBases(dockerfile: string): DockerfileBase[] {
  return logicalInstructions(dockerfile).flatMap((instruction): DockerfileBase[] => {
    const match = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/iu.exec(instruction);
    return match === null ? [] : [{ alias: match[2]?.toLowerCase(), reference: match[1] }];
  });
}

/** Returns fail-closed reasons why a Dockerfile is not backed by the catalog's immutable base-image inventory. */
export function immutableBaseImageIssues(
  baseImages: readonly CatalogBaseImage[],
  dockerfile: string,
): DockerfileBaseIssue[] {
  const issues: DockerfileBaseIssue[] = [];
  const knownStages = new Set<string>();
  const bases = dockerfileBases(dockerfile);
  if (bases.length === 0) {
    issues.push({ kind: 'invalid', message: 'Dockerfile has no readable FROM instruction' });
  }

  for (const base of bases) {
    if (base.reference === 'scratch' || knownStages.has(base.reference.toLowerCase())) {
      if (base.alias !== undefined) {
        knownStages.add(base.alias);
      }
      continue;
    }

    const catalogBase = baseImages.find((candidate): boolean => (
      (base.alias !== undefined && candidate.stages.some((stage): boolean => stage.toLowerCase() === base.alias)) ||
      candidate.reference === base.reference ||
      (candidate.digest !== null && `${candidate.reference}@${candidate.digest}` === base.reference)
    ));
    if (catalogBase === undefined) {
      issues.push({ kind: 'invalid', message: `FROM ${base.reference} is absent from the catalog base-image inventory` });
    } else if (catalogBase.digest === null) {
      issues.push({ kind: 'missing-digest', message: `${catalogBase.reference} has no catalog digest` });
    } else if (!SHA256_PATTERN.test(catalogBase.digest)) {
      issues.push({ kind: 'invalid', message: `${catalogBase.reference} has malformed digest '${catalogBase.digest}'` });
    } else if (base.reference !== `${catalogBase.reference}@${catalogBase.digest}`) {
      issues.push({ kind: 'invalid', message: `FROM ${base.reference} does not use catalog digest ${catalogBase.digest}` });
    }

    if (base.alias !== undefined) {
      knownStages.add(base.alias);
    }
  }

  return issues;
}

function stripShellComment(command: string): string {
  let quote: '"' | '\'' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== '\'') {
      escaped = true;
      continue;
    }
    if (character === '"' || character === '\'') {
      quote = quote === character ? undefined : quote ?? character;
      continue;
    }
    if (character === '#' && quote === undefined && (index === 0 || /\s/u.test(command[index - 1]))) {
      return command.slice(0, index).trim();
    }
  }
  return command.trim();
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Checks that an exact command occurs as a shell command in a RUN instruction, never as a Dockerfile or shell comment. */
export function dockerfileRunsCommand(dockerfile: string, command: readonly string[]): boolean {
  if (command.length === 0) {
    return false;
  }
  const expected = command.map(escapeRegExp).join('\\s+');
  const commandPattern = new RegExp(`(?:^|&&\\s*|\\|\\|\\s*|;\\s*)${expected}(?=$|\\s*(?:&&|\\|\\||;))`, 'u');
  return logicalInstructions(dockerfile).some((instruction): boolean => {
    const match = /^RUN\s+(.+)$/iu.exec(instruction);
    return match !== null && commandPattern.test(stripShellComment(match[1]));
  });
}
