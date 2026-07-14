# Workarounds and integration notes

This log records every non-obvious issue found while wiring the demo to the local Mosoo runtime on 2026-07-14.

## Installer chooses cloud by default

`install.sh` offered cloud login and cloud doctor after installing the CLI and skill. This demo targets local Mosoo, so those prompts were skipped and every generated command uses the explicit local Console host `http://127.0.0.1:8787/api` or Public API base `http://127.0.0.1:8787/api/v1`.

## `mosoo doctor` and Console auth disagree

`mosoo doctor --target custom --base-url http://localhost:5173 --json` reported local auth as not required, while Console GraphQL returned `401`. The stored CLI bearer was stale and the local D1 contained no matching PAT. Workaround: rebuild the PAT with the OAuth device flow:

```bash
mosoo auth login --auth-type oauth --hostname http://127.0.0.1:8787/api --provider google
```

This requires a signed-in browser to approve the one-time code. It is Console CLI auth, not the Agent API token used by this app.

## Agent access-token creation rejected valid CLI bearer auth

After OAuth succeeded, `mosoo console-rest access create` still returned `401`. The POST route used the session-cookie-only viewer helper while its GET and DELETE siblings accepted cookie or bearer authentication. The route now consistently uses `getAuthenticatedViewerFromRequest`; the same CLI command then created the Agent token successfully. The token value is stored only as a Worker secret.

## 5173 was started from a different worktree

Process inspection showed the active 5173/8787 stack came from a different checkout. A valid final smoke must restart the stack from the checkout under test; otherwise repository changes and runtime evidence refer to different code.

## Cloudflare cannot call localhost

A deployed Worker cannot reach `localhost:5173` or `127.0.0.1:8787`. For development, `src/dev-public-api-gateway.ts` exposes only `/api/v1/*` on 8790 and Cloudflare Quick Tunnel supplies temporary HTTPS. Point `MOSOO_API_BASE` at `<tunnel>/api/v1`. Do not tunnel 5173 directly because that also exposes the Console surface.

Quick Tunnel URLs are ephemeral. Restarting `cloudflared` requires updating the Worker variable and redeploying. A stable demo should use a named Tunnel and hostname.

The first deployed probe failed with Cloudflare error `1042`: a Worker fetched another Cloudflare-routed hostname in the same zone. The required compatibility fix is `global_fetch_strictly_public`; it forces the subrequest through the public Internet path. A production named Tunnel should prefer a Workers VPC binding instead of depending on this development flag.

## Tunnel requests produced an unreachable driver callback

The Public API request arrived through the Quick Tunnel, so runtime provisioning initially derived the agent-driver callback from the public hostname. The public-only gateway intentionally rejects `/api/driver/socket`, and the Run failed after a 30-second callback timeout.

Local dev now injects `MOSOO_RUNTIME_CONTROL_ORIGIN=http://host.docker.internal:<wrangler-port>`. Runtime callbacks and MCP proxy traffic use this container-reachable internal origin even when the Run was created through a tunnel. Production keeps deriving its origin from the real request unless an explicit override is configured.

## Public API schema changed

Older Mosoo notes use `files` or `attachmentIds` when creating a Thread. The live OpenAPI rejects those fields. Current sequence: upload multipart `file`, then create the Thread with `resources: [{ "type": "file", "file_id": "..." }]`.

## Mosoo Codex has no built-in image tool

The current runtime exposes `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, and `web_search`; it has no `image_gen`, `view_image`, or subagent tool. Installing the original `hatch-pet` markdown alone therefore cannot work.

Workaround: `hatch-pet-mosoo.skill` includes the unmodified system `image_gen.py` CLI and deterministic hatch-pet scripts. Its instructions replace built-in generation and parallel workers with sequential CLI calls. Upload the `.skill` archive so the scripts are materialized beside `SKILL.md`.

## Credentials and Python packages are separate

Host `~/.codex/auth.json` does not enter an Agent sandbox and cannot call the Image API. The Run needs a Mosoo OpenAI provider credential that injects `OPENAI_API_KEY`. The selected Agent environment must also install `openai` and `pillow` through its package list. Tokens and keys must never be placed in the skill archive or Worker vars committed to Git.

## The default Sandbox image declared `pip` support but shipped no Python

Mosoo generated the expected `pip install 'openai' 'pillow'` setup script, but `cloudflare/sandbox:0.12.3` contained no `python`, `python3`, `pip`, `pip3`, or `uv`; setup failed with exit `127`. The driver image now installs `python3` and `python3-pip`, creates a `python` alias, and verifies both binaries during the image build.

## Stale local HTTPS interception reset all provider traffic

Cloudflare Sandbox local outbound interception did not materialize its ephemeral CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Every HTTPS request inside the container reset, including Codex WebSocket and HTTPS fallback calls to OpenAI. Local mode now disables SDK HTTPS interception while production retains the default.

Wrangler reused an already-running `proxy-everything` container after the code change. The fix did not take effect until the named local sandbox/proxy containers were removed and rebuilt. This cleanup is safe for the ephemeral container filesystem; it does not reset local D1 or R2 state. Verify with an unauthenticated request to `https://api.openai.com/v1/models`: HTTP `401` proves DNS/TLS/egress work without exposing a credential.

## Visual QA is limited in Mosoo

Without `view_image`, the Agent cannot honestly claim visual review of generated strips. The portable skill keeps deterministic frame/atlas validation as the hard gate and includes the contact sheet and animation previews inside the zip for human QA. Automated visual QA is a later capability, not simulated here.

In the end-to-end smoke, deterministic QA caught an empty final cell in `running-left`; the Agent used the supplied retry prompt, regenerated that row, rebuilt the atlas, and passed with zero validation errors or warnings.

## Artifact discovery is path-based

Mosoo records Run outputs only from the session's top-level `outputs/` directory. The skill writes exactly `outputs/codex-pet.zip`; scratch files remain under `.pet-run`. The app polls Thread files and chooses the named zip artifact, then streams download bytes through the Worker so the browser never sees the Mosoo token.

## Keep demo packages small

The current Mosoo artifact path may buffer a complete file in Worker memory. The demo zip contains one WebP atlas plus compact QA files and must remain well below Worker memory limits. Add R2 only if persistence, sharing, or much larger artifacts becomes a real requirement.
