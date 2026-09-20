"""Playwright-Python adapter for the existing, signed-in launch fixture page.

Run in the tester's existing Python notebook, without opening another browser:
    adapter = {}
    exec(open("/home/runner/workspace/scripts/practice-launch-browser-adapter.py").read(), adapter)
    launch_probe = await adapter["install_launch_fixture_routes"](page)
    await page.reload()

No tokens are loaded or returned. The existing app attaches its bearer header.
Do NOT fetch the API with page.request: browser localStorage is not its auth.
This simulates external pending Stripe and completion ONLY. Existing real
details/products/tour saves continue to the API. Do not reset saved fixtures.
"""
import copy
import base64
import datetime
import json
import re
from pathlib import Path


async def install_launch_fixture_routes(page):
    state = json.loads(Path("/home/runner/workspace/.cache/practice-launch-browser/state.json").read_text())
    provider_id = state["providerId"]
    assert provider_id.startswith("launch-browser-"), "Only disposable launch fixtures are allowed"
    # Every entry is safe to print: no identity, snapshot, request or token.
    probe = {"launch_reads": 0, "launch_writes": 0, "last_status": None,
             "pending_applied": 0, "simulated_completions": 0, "blocked_billing_writes": 0,
             "bearer_present": False, "bearer_unexpired": False}
    latest = None
    completed_at = None

    async def launch_handler(route):
        nonlocal latest, completed_at
        request = route.request
        path = request.url.split("?", 1)[0].rstrip("/")
        # Never forward completion: real completion invokes external Stripe.
        if path.endswith("/complete"):
            if latest is None:
                await route.fulfill(status=409, json={"error": "Fixture adapter needs a successful authenticated launch read. Reload this page."})
                return
            if not latest.get("canEdit"):
                await route.fulfill(status=403, json={"error": "Only the practice owner can confirm setup."})
                return
            if not (latest.get("detailsConfirmed") and latest.get("productsConfirmed") and latest.get("security", {}).get("ready")):
                await route.fulfill(status=409, json={"error": "Confirm real fixture details, products and security first."})
                return
            completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
            snapshot = copy.deepcopy(latest)
            snapshot["completedAt"] = completed_at
            snapshot["payments"]["state"] = "pending"
            probe["simulated_completions"] += 1
            await route.fulfill(status=200, json=snapshot, headers={"Cache-Control": "no-store"})
            return

        # route.fetch() preserves the intercepted app request's Authorization.
        # This works for both launch GET and real details/products/tour mutations.
        headers = await request.all_headers()
        authorization = headers.get("authorization", "")
        probe["bearer_present"] = authorization.startswith("Bearer ")
        try:
            part = authorization.split(" ")[1].split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
            probe["bearer_unexpired"] = claims.get("exp", 0) > datetime.datetime.now(datetime.timezone.utc).timestamp()
        except (ValueError, IndexError, KeyError):
            probe["bearer_unexpired"] = False
        response = await route.fetch(headers=headers)
        probe["last_status"] = response.status
        probe["launch_reads" if request.method == "GET" else "launch_writes"] += 1
        if not response.ok:
            await route.fulfill(response=response)
            return
        snapshot = await response.json()
        if snapshot.get("office", {}).get("providerId") != provider_id:
            await route.fulfill(status=409, json={"error": "Fixture adapter refused another practice. Use the disposable fixture session."})
            return
        latest = copy.deepcopy(snapshot)
        snapshot["payments"]["state"] = "pending"
        snapshot["completedAt"] = completed_at
        probe["pending_applied"] += 1
        await route.fulfill(response=response, json=snapshot)

    async def billing_handler(route):
        request = route.request
        if request.method != "GET" or "/connect/" in request.url:
            probe["blocked_billing_writes"] += 1
            await route.fulfill(status=409, json={"error": "Fixture: real Stripe/payment writes disabled."})
            return
        await route.continue_()

    # Register last: Playwright runs the most recently registered matching
    # route first, superseding the tester's earlier unsuccessful adapter.
    await page.route(re.compile(r".*/api/billing/.*"), billing_handler)
    await page.route(re.compile(r".*/api/office/launch(?:/[^?]*)?(?:\?.*)?$"), launch_handler)
    return probe


async def reseed_launch_fixture_session(page, role="owner"):
    """Use only after main minted refresh sessions; contains no API requests."""
    assert role in ("owner", "teammate", "hq")
    envelope = json.loads(Path("/home/runner/workspace/.cache/practice-launch-browser/" + role + ".json").read_text())
    await page.evaluate("""({storageKey,session}) => {
      localStorage.setItem(storageKey, JSON.stringify(session));
      localStorage.setItem('thinnr-ops-code-login-at', String(Date.now()));
      sessionStorage.removeItem('thinnr-ops-persona');
    }""", envelope)
    await page.reload()