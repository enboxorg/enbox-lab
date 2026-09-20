type DockerImagePlatform = {
  Architecture?: string;
  Os?: string;
};

type DockerCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const DOCKER_ARCHITECTURES: Readonly<Record<string, string>> = {
  arm64 : 'arm64',
  x64   : 'amd64',
};

/** Returns whether an image reference is immutable rather than tag-selected. */
export function isDigestPinnedImage(reference: string): boolean {
  return DIGEST_PINNED_IMAGE.test(reference);
}

/** Verifies that Docker selected a Linux image for the host CPU without emulation. */
export function imageMatchesHostArchitecture(
  image: DockerImagePlatform,
  hostArchitecture = process.arch,
): boolean {
  const expectedArchitecture = DOCKER_ARCHITECTURES[hostArchitecture];
  return expectedArchitecture !== undefined && image.Os === 'linux' && image.Architecture === expectedArchitecture;
}

/** Distinguishes confirmed Docker absence from daemon, permission, and transport failures. */
export function dockerResourceIsAbsent(result: DockerCommandResult): boolean {
  return result.exitCode !== 0 &&
    /No such (?:object|container|image|network|volume)|(?:container|image|network|volume)\s+\S+\s+(?:not found|does not exist)/iu
      .test(`${result.stderr}\n${result.stdout}`);
}
