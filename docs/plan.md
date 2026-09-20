**Enbox Lab — development plan v0.3**

2026-09-20, refined during P0 implementation. This is the current plan. It retains the accepted signed-publication persistence design and makes the runtime boundaries, command coverage and delivery gates explicit. Enbox source findings were checked against `05b41776e92bd1f42462726d7a7d4bb2a0fcb9de`; recheck them against the selected SDK revision.

Read this document for the product and architecture. The accompanying [assumption and acceptance checklist](./acceptance.md) records what still needs proof.

**1. Goal and scope**

Build a local network lab for creating and reopening isolated Enbox environments, running DWNs at selected versions, managing real wallets and identities, and observing real browser application flows. Include five built-in scenarios and a DID infrastructure diagnostic. Each run produces functional assertions and inspectable event evidence. The UI and CLI use the same controller operations so an agent can operate the lab without driving its canvas.

| Status | Decision |
| --- | --- |
| User confirmed | Browser UI, host Bun controller, Docker-managed DWNs; real Enbox agents/vaults/identities; real browser dapp flows; Linux and macOS. |
| User required | Each lab owns its did:dht service, and all of its servers/clients use it. Existing host Enbox instances must remain unaffected. |
| User accepted | Persist accepted signed public DID publications and replay them through real Pkarr APIs after private-DHT recreation. |
| Proposed defaults | Standalone `enboxorg/enbox-lab` project; React/Vite/React Flow; Docker Compose; containerized wallet workers; Chromium as the first supported browser. Other browsers/runtimes are additional support work, not implied by the OS targets. |

V1 varies **DWN server versions**, using a curated catalog and one pinned wallet/dapp SDK build. Its browser actors are built-in fixture applications using actual Enbox APIs. General third-party app attachment, additional DWN implementations, external wallet applications, custom experiments, arbitrary scripts/plugins, desktop packaging, cloud hosting, simulated latency/loss, and in-place node upgrades are outside v1.

Wallet and tenant identities use did:dht. SDK-created did:jwk delegates remain self-resolving; they do not contact the DHT. Do not replace the required did:dht identities with another method to avoid publication.

The starter fixture has three DWNs, two wallets with two identities each, two browser dapp instances, and one owned DID service. Counts are configurable; the fixture is the acceptance baseline. One capable DWN hosts the connect relay. The outage scenario stops another DWN so an unrelated relay outage does not confound its result.

The first useful delivery is smaller: one DWN, one wallet identity and one browser app create, decrypt and observe a private note, then reopen the same lab with the same identity and stored note. Build that path before the topology editor. The full fixture and all five scenarios remain the v1 completion requirement.

**2. One controller and one owned environment per lab**

| Component | Owns |
| --- | --- |
| Host Bun controller | Lab specifications, image preparation, Docker lifecycle, jobs, scenario runs, event journal, CLI/API and managed browser processes. |
| Per-lab gateway | Fixed routes for actor origins, HTTP/WebSocket forwarding, static browser assets, scoped management/telemetry channels, and the DID-publication adapter. It is not an open proxy. |
| Pkarr testnet container | Real upstream Pkarr relay and private Mainline DHT; no public bootstrap. The adapter's durable journal survives this container's recreation. |
| DWN containers | One actual selected server artifact and independent data volume per node generation. Default storage uses the existing Level/SQLite options. |
| Wallet containers | A small supervisor and one real EnboxUserAgent process, encrypted vault, identity/key stores, local DWN and independent volume per wallet. The supervisor can remain available while the agent is locked. |
| Browser actor pages | Normal ConnectionStore, delegated session, local IndexedDB replica and application-owned service worker. Each actor has its own persistent origin. |

Only the controller accesses Docker. The gateway performs service routing; Enbox remains responsible for authorization, signing, encryption, storage, sync and connect. The controller never copies records into a destination to make a scenario succeed.

Keep `packages/lab` for contracts/controller/runtime/CLI/scenarios, and add `apps/lab` for the browser management UI and fixture entrypoints. Gateway and wallet roles can use the same pinned lab runtime image with different entrypoints. Avoid separate orchestration services, a message broker, an OTel collector, or an independent plugin platform.

Use three explicit communication paths:

| Path | Contract |
| --- | --- |
| UI/CLI → host controller | Authenticated local API; typed commands return a durable job ID. Snapshots and a resumable event stream serve both clients. The management UI has a separate origin from fixture apps. |
| Controller → gateway → wallet supervisor | The host initiates an authenticated connection through the gateway's owned loopback entrypoint. Fixed actor routes carry commands, results and telemetry; containers need no callback route to arbitrary host services. Scope wallet-page access to its wallet and connect session. |
| Browser/wallet/DWN → gateway → selected service | Real Enbox and Pkarr traffic. Management credentials are never forwarded to DWNs, relays or dapps. Protocol traffic remains independent of the controller's command connection. |

Proposed storage is a controller SQLite database for specifications/jobs, a separately bounded event journal, and a separate durable SQLite database in the gateway volume for accepted DID publications. Actor stores and owned browser profiles remain outside these databases. Gateway maintenance and protocol services continue during command-channel reconnection. A controller crash interrupts runs; report any managed browser exit separately from service availability. Losing the gateway affects every proxied service and must be reported as a gateway fault.

The controller stores desired configuration and layout. Agents/DWNs own actual identities, grants and records. Runtime state and the canvas are observations of those systems; cached labels on a locked wallet are explicitly last-known state. Generated Compose is a derived artifact, not a second editable source of truth.

**3. Containment and address contract**

Each installation and lab has an immutable random ownership ID. Label every container, network and volume with owner/lab/actor IDs; display names never determine ownership. Use an explicit Compose project, configuration file, working directory and controlled environment. Shared immutable image layers are fine; mutable state is separate.

All host listeners bind to loopback. Backend services use the lab's private network and only the gateway publishes entrypoints. Docker's internal-network setting is useful but does not alone prevent access to every host service; explicit configuration, routing restrictions, disabled discovery and coexistence tests also enforce the boundary. [Docker network behavior](https://docs.docker.com/engine/network/port-publishing/).

Every agent, including a prebuilt agent passed into AuthManager, uses an explicit data path and `localDwnStrategy: 'off'`. Do not discover/reuse `.enbox` nodes, invoke the host development stack, inherit unrelated `.env`/Compose overrides, attach existing networks, mount the home/repository/Docker socket into actors, or change machine DNS/firewall/CA settings. Cleanup verifies ownership and never uses global Docker pruning or kills a process occupying a desired port.

The Linux P0 routing spike selected distinct `http://localhost:<actor-port>` origins as the current candidate. The original `*.localhost` candidate works in Chromium and host Bun, but the pinned Linux Bun 1.3.14 container cannot connect to a multi-label localhost name even when both loopback families have listeners. Distinct ports preserve browser origin isolation and secure-context behavior without depending on that inconsistent name resolution. Freeze this decision only after real wallet, both server runtimes, forwarding and native macOS use the same route. [Localhost resolution rules](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3), [secure-context rules](https://www.w3.org/TR/secure-contexts/#localhost).

The gateway publishes each actor's saved loopback port on the host. A bounded byte-preserving forwarder binds the same IPv4 and IPv6 loopback port inside each affected actor and reaches the gateway over its private backend network. A separate gateway ingress network permits loopback publishing while actors remain on an internal network. The Linux echo-gateway proof preserved the identical URL and exact Host/Origin semantics for HTTP and reconnecting WebSockets from host Bun, container Bun, Chromium, a service worker and a popup. This is platform-scoped transport evidence, not proof of wallet/server/forwarding integration. Do not add machine DNS/hosts/CA changes, public DNS dependencies, host networking or disabled browser security.

A saved DID endpoint must work from the page, service worker, wallet container and every server, including server forwarding. Set each server's advertised base URL to its canonical external endpoint. Test HTTP, WebSockets, CORS, secure-context/service-worker behavior, IPv4/IPv6 behavior and the DID packet size limit. Prefer separate actor windows/tabs; embedded fixture frames introduce ancestor-origin and popup behavior that is outside the initial UI design.

Allocate addresses before creating identities. Retry a creation-time bind collision; on reopen, a saved-port conflict is an actionable failure, not automatic rebinding. Origin changes affect DID routing and browser storage. Clone/import creates new IDs, origins and identities. Do not reuse retired origins for unrelated labs.

Browser management uses strict Host/Origin checks and authenticated, actor-scoped channels. Host-only cookies cannot substitute for Origin checks. Browser assets, wallet selection and network policies reference only the lab. Once pinned artifacts are prepared, built-in scenarios operate without internet services. V1 uses a supported local Docker Engine/Desktop endpoint; remote daemons and arbitrary images are outside its containment contract.

Containment evidence includes page and service-worker traffic, redirects and fresh DID misses; a Docker network setting or page-only request interception is insufficient. Keep service workers enabled in browser acceptance. Playwright distinguishes worker-owned requests and documents interception limitations, so use gateway and runtime evidence as well. [Playwright service-worker networking](https://playwright.dev/docs/service-workers).

**4. DID persistence and complete client configuration**

Use the accepted **upstream private testnet plus signed-publication journal** design. The adapter belongs to the per-lab gateway, with its own durable database/volume independent of trace retention. Every publication passes through it; clients never use the raw upstream endpoint directly.

Publication contract:

1. Serialize client publication, restoration and periodic re-publication through the same per-key queue. Check the durable latest version before forwarding to prevent regression after an upstream reset; otherwise forward the original packet through real Pkarr validation/publication.
2. Persist the latest upstream-accepted packet, exact signed bytes, key and version durably before returning success. Preserve integer precision and reject regression according to the pinned upstream semantics. Identical retries are safe; conflicting/stale packets cannot replace newer accepted state.
3. On testnet recreation, replay those bytes through Pkarr. Do not generate new signatures or sequence numbers, or require wallets to unlock.
4. Re-publish periodically during normal operation and after host wake/reconnection. DHT entries may expire without re-announcement; BEP44 recommends hourly re-announcement and permits anyone holding the signed packet to do it. Pin an interval compatible with the selected upstream implementation. [BEP44 expiration](https://www.bittorrent.org/beps/bep_0044.html#expiration).
5. Resolve through the real relay/DHT and normal signature verification. Readiness verifies restoration and a cold/network-only lookup; warm client or relay caches alone are insufficient.

Startup is `open/validate journal → start private testnet → restore latest packets → verify network resolution → admit publications`. The durable latest version must prevent regression even when the recreated upstream has forgotten all prior state. Take the current packet under the per-key queue when replaying; do not enqueue an old snapshot that can overwrite a concurrent update. P0 must establish what the pinned relay's successful PUT means, including identical-packet refresh, and distinguish durable acceptance from observed DHT availability. Verify an actual network lookup against the restored testnet with relay caches bypassed; a fresh SDK resolver alone only clears the client cache.

There is no atomic transaction across upstream DHT state and the journal. If publication succeeds upstream but the journal/response fails, return failure or an unknown outcome; do not promise rollback. Once success was acknowledged, restart must retain that version or a subsequently accepted newer one. Fail durable writes visibly if storage is full. Routine trace cleanup never deletes DID state.

The journal restores public identity information, not wallets or DWN records. Keep it until the lab is deleted; removing a local wallet identity is not DID unpublication. Corrupt/unavailable durable state produces a failed/degraded lab, never a quietly regenerated identity.

Every DID path needs explicit **per-instance network configuration**: vault creation/recovery/publication, identity endpoint updates, agent resolution, connect verification, server authorization/forwarding, browser page and service-worker DRL resolution. A single resolver override or process env setting is insufficient. Scope minimal SDK configuration additions while preserving default production behavior, signature checks and explicit private-gateway opt-in. Include resolver/cache instances in the isolation audit.

Define one immutable lab DID configuration containing the canonical gateway URI and explicit private-gateway opt-in, and thread it through instance factories and their publish/resolve collaborators. Each page and service worker loads its own actor-scoped public bootstrap configuration before initializing Enbox. [Enbox PR #1726](https://github.com/enboxorg/enbox/pull/1726) adds this binding to the default agent, auth, anonymous API and browser paths; the lab will consume the resulting package cohort after release. Do not monkey-patch static methods or mutate host-wide defaults. Self-resolving did:jwk verification remains unchanged.

Existing direct call sites are in [HdIdentityVault](https://github.com/enboxorg/enbox/blob/main/packages/agent/src/hd-identity-vault.ts), [AgentDidApi](https://github.com/enboxorg/enbox/blob/main/packages/agent/src/did-api.ts), and [AgentIdentityApi](https://github.com/enboxorg/enbox/blob/main/packages/agent/src/identity-api.ts). The existing server offers resolver injection for processing and forwarding. Historical builds must be audited separately; current hooks do not establish their support.

A DID-only fault disables the DID route or stops its upstream while the shared gateway's DWN routes stay available. Cold lookups then fail; already cached, valid identities may still support operations and must be shown as cache hits. Stopping the entire shared gateway would confound this diagnostic with a DWN transport outage. New updates and convergence must not be inferred from old cache contents.

**5. Product behavior and lifecycle**

The UI has a component list/palette, topology, inspector and event timeline. Cards expose versions, lifecycle, wallet identities, delegated sessions, endpoints and trace coverage. Provide a keyboard-accessible actor list. Node placement affects layout only; endpoint assignment is an explicit inspector action with pending/succeeded/failed state, not an implicit consequence of drawing an edge.

| Action | Meaning in v1 |
| --- | --- |
| Start/reopen lab | Reconcile owned resources, prepare DID service and nodes, then expose actors. Wallets reopen locked; browser sessions may restore independently. Readiness reports infrastructure, wallet lock state and app connectivity separately. |
| Stop lab | Stop owned runtime services and managed browsers, preserve durable volumes and metadata. Closing the UI alone leaves the controller running. |
| Lock wallet | Stop accepting wallet work, drain within a deadline, terminate its agent process and report uncertain in-flight outcomes. Existing delegated dapps can continue until grants expire or are revoked. Unlock creates a new agent process over the same stores. |
| Revoke dapp | Use real permission revocations and report target-specific propagation. Cached plaintext is not erased. Reapproval is a separate action. |
| Remove identity | Stop its managed sync and remove its wallet identity registration. This is not secure key erasure, grant revocation or remote record deletion; the current identity-delete API removes metadata. |
| Delete wallet/lab | Remove the specifically selected owned resources and state. Managed browser profiles can be deleted; dormant storage in a user's normal browser cannot be assumed erased. Retire its origins. |
| Change node version | Create a replacement node with fresh storage; explicitly provision/reassign endpoints. Do not open an old volume with a different binary. |
| Duplicate/export/import | Recreate configuration and fixture intent with fresh identities. No seeds/private keys, record snapshots or exact-state restoration. |

Wallets support creation, naming, unlock/lock, identity creation/naming/removal, endpoint assignment, connection approval and revocation. Each dapp actor has one active delegated identity. Use another actor to work with another identity; switching/resetting an actor is explicit. Distinct app origins and delegates are required even when both apps use one identity.

Use the real connect provider/kernel and approval ceremony. The provider page is UI; a narrow authenticated worker API operates the wallet agent. Prove the browser-popup/worker boundary and origin validation early. Passwords, PINs and keys stay out of command arguments, Compose env, traces and exported recipes. Unlock passes through a short-lived secret channel; restart does not silently unlock wallets.

For popup connect, retain `WalletPostMessageTransport` in the provider page: it owns the opener/origin checks and ephemeral request-decryption key. Bind the validated request to a short-lived worker session; approval calls `executeConnectApproval` and seals the response through `ConnectProvider` in the wallet worker. Return the sealed response to the page for delivery. Relay connect uses the real relay transport and PIN flow. P0 verifies this split against both transports; do not turn the worker API into an arbitrary signing or key-export endpoint. Cancellation, denial, expiry and worker restart invalidate the pending session.

Automated runs own a persistent Chromium profile per lab and one active runtime lease per actor. They drive the same fixture controls and consent path as guided runs. Starting an automated run authorizes only its declared fixture actions, including explicit approval/denial steps. Supply test wallet secrets through the ephemeral secret channel; absent secrets leave a resumable `waiting-for-input` job. Normal-browser fixture use is manual and is not evidence for managed-browser lifecycle guarantees.

Endpoint assignment provisions supported tenant/protocol prerequisites, publishes the DID update and waits for observed routing readiness. It does not promise immediate cache invalidation, a full historical data migration, or deletion from removed nodes. Surface pending replication and cached endpoint use. Payments/external registration infrastructure are outside the starter configuration.

A single controller lease owns each lab's mutable operations. On one host, use an OS-backed exclusive lock; never take over solely because a timestamp expired. Commands have idempotency keys, payload hashes and expected revisions. A retry with the same key and payload returns the existing job; a changed payload or stale revision is a conflict. Read-only inspection and layout changes remain available while an operation runs.

Recover owned containers and interrupted jobs after a crash. Reconcile Docker operations against ownership IDs; for identities, grants, writes and endpoint publications, inspect the actor's actual state before deciding whether a step can resume. Uncertain mutations enter `needs-reconciliation`, not an automatic retry. During a scenario, freeze structural configuration except for its declared fault actions. Controller shutdown, node outage, wallet lock and browser suspension are distinct events.

**6. Observation and visualization**

Use actor SDK/connect/sync observations, supported server processing hooks and gateway transport metadata. The gateway preserves signed messages, payload streaming, WebSocket ordering/acks and backpressure. Instrumentation loss cannot change application results; mark missing evidence explicitly. Coverage is version-specific.

The visual model distinguishes:

| Layer/stage | Evidence |
| --- | --- |
| Configured relationship | Wallet membership or advertised endpoint assignment; not a transfer. |
| DID / authorization | Actual publication, resolution, consent and permission observations. Cache hits remain local. |
| Sent | A transport attempt, with its actual target and retry identity. |
| Accepted by DWN | A DWN outcome; outer HTTP 200 alone is insufficient. |
| Applied locally | Receiver sync/store evidence for that message version. |
| Visible to app | The authorized application's actual subscribed view/read. |

Graph, actor timeline and inspector share selection. Group a logical record by tenant/record ID, updates by message CID, and retries by connection/request/attempt. Record producer epoch/sequence, ingestion cursor and causal links; uncertain attribution remains unknown. Compute precise durations within a producer, not by subtracting unrelated clocks. Optional inferred paths are labeled and cannot satisfy required assertions.

Topology uses restrained semantic markers and counted bursts; detailed events remain in a bounded journal. Include filters, reduced motion, visible gaps and an accessible event list. **Follow live**, **pause scenario at a step**, and **stop actor** are separate controls. Replay is read-only and never reissues a write.

Trace metadata is redacted before persistence. Payload preview is an explicit authorized read, separate from tracing. Bounded queues, retention and disk-full behavior are required; a lost interval makes dependent assertions inconclusive. Cache/DID maintenance and health traffic are grouped so they do not obscure the scenario.

Keep job results and assertion verdicts durable separately from best-effort telemetry. Never block a DWN response on trace persistence. A run report records functional verdict, required evidence coverage, expected/observed record versions, target-specific failures and gap intervals. If retained evidence is deleted, retain an explicit `evidence-expired` reference instead of presenting a complete replay. The event stream resumes from a cursor; an expired cursor returns a gap and fresh snapshot.

Use `records.observe()`/`subscribe()` for live record state. Keep existing SDK auth-status monitoring, delegated renewal and durable-feed reconciliation. The rule prohibits new record-query polling loops, not legitimate SDK or infrastructure timers. See [browser application architecture](https://github.com/enboxorg/enbox/blob/main/docs/architecture/browser-dapps.md).

**7. Built-in scenarios and their isolation**

Runs use lab-created fixture protocols, records, identities and delegates with explicit role bindings. Automated acceptance creates a fresh owned lab per test; the UI defaults to a dedicated scenario fixture. Never silently reset existing work or infer arbitrary user records as fixtures. One run per lab at a time; separate labs can run concurrently. Guided and automated modes execute the same operations with real approvals. Time, expiry and background sync keep running while guided steps wait.

| Scenario | Passing evidence |
| --- | --- |
| Connect and private note | Real relay connect plus popup/deny variants. Scoped grants; encrypted note goes app → DWN → wallet; authorized content matches; outsider denied for the expected reason. |
| Two apps, one identity | Independent origins/delegates. Create/update/delete in A converges in B's subscribed view with the expected record and message versions. |
| Cross-wallet sharing | Typed shared-context roles/invitations establish access; Bob contributes and Alice observes. Correct owner tenant retained; outsider access denied. |
| Node outage/recovery | After provisioning, prove B has the baseline and stop its actual container. Create/update/delete while B is down; assert healthy/local results and B's failure. Restart the same B artifact and volume; prove direct remote state plus subscribed convergence without duplicate logical records. Exercise same and mixed versions. |
| Revoke one app | Capture the exact grant/session and a successful protected remote request, establish revocation at the target, then send a fresh valid request under that same unexpired grant and prove rejection. The other app still works. Track renewed/reapproved sessions separately. Local refusal, expiry, transport failure and missing data do not substitute for server enforcement. |

Add one **DID diagnostic**: publish/update → cold resolve → restart → restore → fresh verification with wallets locked, including periodic re-publication and an unavailable-gateway case.

The normal fixture uses agent sync with server forwarding/delivery disabled, preserving the existing server defaults. A separate bounded forwarding variant explicitly enables `DWN_FORWARDING_ENABLED`, blocks alternative agent replication of its chosen message, and proves server A → server B through both traffic evidence and a direct authorized read. Protocol-aware `$delivery` is a separate capability and is not implied by endpoint forwarding. These flags and endpoint-cache settings belong in the run lock. [Server configuration](https://github.com/enboxorg/enbox/blob/main/packages/dwn-server/src/config.ts#L263).

Assertions use bounded predicates with named deadlines and positive/negative controls. Functional success and path completeness are separate results. Supported required checks must pass; unsupported/inconclusive/failed/cancelled/interrupted states never count as passing. Cancellation preserves committed effects and evidence. A fresh run namespace is not a promise of clean state for revocation/outage tests; those use fresh fixtures.

Each scenario definition names role bindings, capability prerequisites, setup, actions, assertion targets, cleanup and recovery behavior. Register observations before triggering a write to avoid missing fast events. Bound convergence by named operation deadlines frozen in the run lock; avoid arbitrary sleeps or polling record queries. A denial assertion checks the DWN status/error and a working positive control at the same target. Scenario fault steps are allowlisted operations, not arbitrary shell commands.

**8. Versions, contracts and automation**

Ship a small curated catalog: exact source revision, dependency lockfile, build recipe, base/Bun image identities, CPU platform, actual server/SDK versions and capabilities. Build historical artifacts against their own dependency closure. Cache immutable artifacts. Candidate versions remain server 0.1.43 / SDK 0.4.27 (`f9d159d75e7fd533f7b8db78a15c76f9e51a449e`) and server 0.1.42 / SDK 0.4.26 (`0ff8d4395bf9940ec888c3be4553b3c0eacde7f9`); these have not been qualified together.

Verify one reference build for all scenarios, then a two-version configuration for connect/write/read/live-sync and outage recovery. Capabilities include the ability to use the private DID network and the available observation hooks. Use artifact digests/source identities, not only package version labels. Native amd64/arm64 images and exact Linux/macOS/browser/Docker support must be backed by platform evidence; emulation does not prove native support.

Historical artifacts use their original dependency closures plus an identified launcher using supported configuration/injection APIs. If isolation or observation requires patching a historical server, record a distinct patched source identity and do not describe it as the unmodified release. Prefer choosing another compatible catalog entry. Qualify the reference and one explicit mixed topology; this does not promise every ordering or future combination. Preflight rejects missing required capabilities before creating fixture identities.

Keep six versioned contracts:

- `LabSpec`: revisioned desired actors, roles, configurations and endpoint assignments with immutable ownership IDs; layout has a separate revision. No secrets or authoritative copies of wallet records.
- `LabLock`: immutable realization of a spec revision: exact artifacts, addresses, effective flags, DID network and capability results. New structural configuration creates a new lock; every run retains its original lock.
- `RuntimeSnapshot`: observed states, actor generation, observed-at/freshness, spec/lock references and active jobs. Unreachable actors become unknown/stale, not inferred stopped.
- `LabCommand`: typed operation, actor/lab ID, idempotency key, payload hash and expected structural revision; secret input separate. Accepted jobs expose progress and a terminal result.
- `LabEvent`: schema version, producer ordering, actors/tenant/message/transport, stage/outcome, causal links and coverage. Distinguish event time from ingestion order.
- `ScenarioRun`: definition/version, role bindings, locked inputs, step states, assertions, deadlines, functional/evidence verdicts and trace references.

The controller accepts UI and CLI commands through the same application service. Every UI mutation needs a typed CLI equivalent; lifecycle-only verbs would not satisfy agent operation of the lab.

| Command group | Required operations |
| --- | --- |
| Environment | `doctor`, artifact `prepare`, `create`, `start`, `status`, `inspect`, `stop`, `delete`, recipe `export`/`import`/`duplicate`. |
| Actors | Add/remove/rename actors; start/stop nodes; replace node version; create/unlock/lock wallets; create/name/remove identities; assign endpoints; open/close/reset app actors. |
| Connections and runs | Inspect/approve/deny pending connections, revoke a session, start/pause-at-step/resume/cancel a built-in scenario or DID diagnostic. |
| Evidence and jobs | Inspect/wait/cancel jobs, stream/query events with cursors, read assertion reports and export redacted run evidence. |

Exact verb spelling is a P1 schema task. JSON responses include stable IDs, error codes and job/run references. `run --wait` exits zero only for a passing run with all required evidence; failed, inconclusive, unsupported and interrupted outcomes return nonzero with a structured verdict. Without `--wait`, submission success means only that the job was accepted. There is no public custom-scenario language or MCP dependency in v1.

**9. Execution order and definition of done**

| Stage | Exit condition |
| --- | --- |
| P0 — prove boundaries | Complete the four ordered spikes below. Record chosen mechanisms and executable proof, including Linux/macOS routing evidence; no unresolved architectural gate is disguised as a passed assumption. |
| P1 — headless ownership | Schemas and controller/CLI can prepare/create/start/stop/reopen/delete two labs without affecting existing services; command conflicts, crash and partial-start recovery work. |
| P2 — first usable lab | Package the one-app/wallet/DWN private-note path as a CLI flow and minimal list/inspector UI; outsider denied; evidence links to real operations. Stop/reopen preserves identity and data; lock, reload and reconnection work. |
| P3 — complete lab | Multiple actors/versions, management UI, topology/timeline/inspector, all scenarios/diagnostics, reports and recipe export. |
| P4 — release evidence | Required checks/CI green; Linux/macOS evidence, bounded resources/retention, repeated fresh runs and coexistence/cleanup checks pass. |

P0 is four runnable proofs, in dependency order:

1. **Addressing and ownership:** minimal gateway plus actual browser/SW, wallet and server runtimes; the same advertised URL works for HTTP/WS/forwarding on Linux and macOS. Prove two labs and an occupied host development port coexist. Freeze the routing decision. Checklist A01–A05; cleanup hardening continues in P1/P4.
2. **Durable private DID network:** real testnet, publication adapter and complete per-instance configuration. Test concurrent versions, crash windows, recreation, cold lookup, locked-wallet replay and maintenance calls. Freeze the Pkarr artifact, acceptance semantics and refresh interval. A06–A11; the full retention soak remains a P4 gate.
3. **Real browser/worker path:** one encrypted note using real popup and relay approvals, denial and the required service worker. Show request/acceptance/application evidence and secrets handling. Freeze the connect split and minimum observation hooks. A10, A13, A18, A24; lifecycle breadth continues in P2.
4. **Version qualification:** two complete artifacts pass private-DID configuration and the core connect/write/read/live-sync path; verify the separate forwarding capability. Freeze the catalog and explicit mixed topology. A17, A20; full scenario qualification remains P3/P4.

Each spike produces a runnable harness, pinned inputs, evidence and a short decision record. Reuse proved code in P1/P2; P0 does not build the canvas or a general orchestration framework. If a candidate fails, resolve the contained alternative before general UI work. The [checklist](./acceptance.md) is the gate record. Source inspection does not mark checks passed.

P1–P3 can progress on proved boundaries while long-duration P4 checks run, but release still requires the full platform matrix. Before P4, freeze numerical startup/convergence/shutdown deadlines, maximum actor counts, memory/event-queue limits and journal retention from measured fixtures. Include repeated fresh runs, suspend/resume, full-stop/reopen, trace overflow and a session exceeding actual upstream retention with wallets locked.

The eventual one-shot execution packet consists of this plan, the completed P0 decisions, schemas, pinned catalog, exact acceptance commands and a resumable task ledger. Follow this repository's `AGENTS.md`, pinned Bun, required lint/build/tests, PR review and green CI. Put reusable SDK changes and their changesets in `enboxorg/enbox`; consume released `@enbox/*` packages here. Verification services must be lab-owned and must not touch an existing host development stack.

The architecture retains the researched lessons from Polar's domain adapters and generated Compose, Kurtosis's owned environments, and Hubble/Perfetto's linked topology and event inspection without turning the lab into a general orchestration or tracing platform.
