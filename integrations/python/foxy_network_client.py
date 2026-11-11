"""Foxy Network partner client for Foxy Finance (Python, standard library only).

Drop this file into the Foxy Finance backend. Every request is signed with
HMAC-SHA256, so the shared secret is never sent over the network.

    from foxy_network_client import FoxyNetworkClient

    client = FoxyNetworkClient(
        base_url=os.environ["FOXY_NETWORK_URL"],
        secret=os.environ["FOXY_FINANCE_API_SECRET"],
    )

    # 1. A user pastes the code shown in their node's dashboard:
    client.redeem_link_code("ABCDE-FGHJK", user_id=TenantContext.get_user_id())

    # 2. Before billing, ask which discount their hardware has earned:
    benefits = client.get_user_benefits(TenantContext.get_user_id())
    discount = benefits["discountPercent"]

    # 3. Offload generic compute (parameters only, never source code or positions):
    job = client.run_job("monte_carlo_gbm", {"paths": 100000, "steps": 30, "sigma": 0.4})
    var_95 = job["result"]["valueAtRisk95"]

Always pass the user id from the authenticated session (never from request
input): that is what stops one user from claiming another user's node.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class FoxyNetworkError(Exception):
    def __init__(self, message: str, status: int = 0, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class FoxyNetworkClient:
    def __init__(self, base_url: str, secret: str, key_id: str = "foxy-finance", timeout: float = 15.0):
        if not base_url or not secret:
            raise ValueError("base_url and secret are required")
        self.base_url = base_url.rstrip("/")
        self.secret = secret.encode("utf-8")
        self.key_id = key_id
        self.timeout = timeout

    # -- signing ---------------------------------------------------------
    def sign(self, method: str, path: str, body: bytes, timestamp: Optional[int] = None) -> dict:
        ts = str(int(time.time()) if timestamp is None else timestamp)
        body_hash = hashlib.sha256(body).hexdigest()
        canonical = f"{ts}.{method.upper()}.{path}.{body_hash}".encode("utf-8")
        signature = hmac.new(self.secret, canonical, hashlib.sha256).hexdigest()
        return {"X-Foxy-Key-Id": self.key_id, "X-Foxy-Timestamp": ts, "X-Foxy-Signature": signature}

    def _request(self, method: str, path: str, payload: Optional[dict] = None) -> Any:
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = self.sign(method, path, body)
        if body:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=body or None, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            try:
                data = json.loads(raw)
            except ValueError:
                data = None
            message = (data or {}).get("error") if isinstance(data, dict) else None
            raise FoxyNetworkError(message or f"HTTP {err.code}", err.code, data) from None
        except urllib.error.URLError as err:
            raise FoxyNetworkError(f"Foxy Network unreachable: {err.reason}") from None

    # -- network ---------------------------------------------------------
    def get_network(self) -> dict:
        """Online capacity, available job types and the benefit matrix."""
        return self._request("GET", "/api/partner/v1/network")

    # -- account linking -------------------------------------------------
    def redeem_link_code(self, code: str, user_id: str) -> dict:
        """Binds the node behind a donor's one-time code to `user_id`."""
        return self._request("POST", "/api/partner/v1/links/redeem", {"code": code, "userId": str(user_id)})

    def revoke_link(self, node_id: str, user_id: str) -> dict:
        return self._request("POST", "/api/partner/v1/links/revoke", {"nodeId": node_id, "userId": str(user_id)})

    def get_user_benefits(self, user_id: str) -> dict:
        """Discount and plan `user_id` has earned with the hardware they contribute."""
        quoted = urllib.parse.quote(str(user_id), safe="")
        return self._request("GET", f"/api/partner/v1/users/{quoted}/benefits")

    def get_user_payments(self, user_id: str) -> dict:
        """Plans `user_id` paid by burning $FOXY from a linked node."""
        quoted = urllib.parse.quote(str(user_id), safe="")
        return self._request("GET", f"/api/partner/v1/users/{quoted}/payments")

    # -- compute jobs ----------------------------------------------------
    def submit_job(self, job_type: str, params: Optional[dict] = None, **options: Any) -> dict:
        """options: replicas (1-3), externalRef, idempotencyKey, billingUsd."""
        payload = {"type": job_type, "params": params or {}, **options}
        return self._request("POST", "/api/partner/v1/jobs", payload)["job"]

    def get_job(self, job_id: str) -> dict:
        return self._request("GET", f"/api/partner/v1/jobs/{urllib.parse.quote(job_id, safe='')}")["job"]

    def wait_for_job(self, job_id: str, timeout: float = 120.0, interval: float = 1.5) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_job(job_id)
            if job["status"] in ("COMPLETED", "FAILED"):
                return job
            if time.monotonic() > deadline:
                raise FoxyNetworkError(f"Job {job_id} did not finish in time", 408, job)
            time.sleep(interval)

    def run_job(self, job_type: str, params: Optional[dict] = None, timeout: float = 120.0, **options: Any) -> dict:
        """Submits a job and waits for its result."""
        job = self.submit_job(job_type, params, **options)
        return self.wait_for_job(job["id"], timeout=timeout)
