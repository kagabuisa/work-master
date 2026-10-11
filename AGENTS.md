# Project instructions

After every successfully completed change, run `docker compose up -d --build invoice-app` to rebuild and restart the local app before reporting completion. Finish the relevant checks first, then verify that the rebuilt app starts and responds on its configured local port. If checks or the rebuild fail, resolve the failure where possible and clearly report any remaining blocker; do not claim successful completion.

Keep user-facing documentation current as the app develops. In the same change as a voucher, screen, validation, permission, or report change, update the relevant section of `docs/app-guide.md`. Update `docs/permissions.md` for access-rule changes and `README.md` for setup or operational changes. Verify descriptions against the implemented behavior and avoid documenting planned behavior as current behavior.

## Local testing

Use the local Docker runtime for JavaScript checks and tests when Node.js is unavailable on the host. Do not stop at `node: command not found` or ask the user to remind you. The local app image is `work_master-invoice-app`; check local image availability and build it if needed. Run a temporary container against the current workspace rather than testing a running app container's potentially stale source:

```sh
docker run --rm --network none --entrypoint sh \
  -v "$PWD:/workspace:ro" -w /workspace work_master-invoice-app \
  -c 'export NODE_PATH=/app/node_modules; node --test tests/hr.test.js'
```

Replace the test command with the checks appropriate to the change. This container uses the image's Node.js and dependencies, mounts the current source read-only, and has no network access or application environment file. Do not use a VPS or another remote machine for routine tests. Database integration tests require a separate local test database and the safeguards documented in `README.md`; never run schema-resetting tests against the application database. Report which checks ran and any remaining limitations.
