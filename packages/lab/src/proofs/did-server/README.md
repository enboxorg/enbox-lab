# Released server private-DID proof

This proof runs the exact released `@enbox/dwn-server@0.1.43` in separate child processes for two independently owned Pkarr testnets. The server receives its final public loopback origin before startup and uses an injected `UniversalResolver` containing `did:dht`, `did:jwk`, and `did:key`. The `did:dht` adapter always forces the assigned protected resolver ingress and private-gateway opt-in; `did:web` and resolver caching are absent.

The capability-bearing resolver URI travels to the child once over bounded stdin. It is absent from arguments, the controlled child environment, readiness, evidence, errors, and serialized runtime objects. A stable loopback proxy gives the released server a correct public base URL while the child binds an ephemeral private backend port.

The live proof publishes one `did:dht` identity only in lab A, then observes four self-targeted signed requests:

- Lab B resolves through B and returns `GeneralJwsVerifierGetPublicKeyNotFound`.
- A self-resolving `did:jwk` request succeeds at B without contacting either Pkarr ingress.
- Lab A resolves through A and accepts the authentic signature.
- A distinct tampered request resolves through A before returning `GeneralJwsVerifierInvalidSignature`.

Each phase snapshots both ingresses and records only request methods and paths. The proof requires the expected ingress to receive exactly one identifier lookup while the other remains unchanged. Cleanup stops both children, both adapters, their temporary storage, and both exact Docker-owned testnets.

This establishes the current released server's authorization-resolution subcheck. It does not establish forwarding, historical-server support, or the default agent, auth, page, and service-worker DID configuration paths.
