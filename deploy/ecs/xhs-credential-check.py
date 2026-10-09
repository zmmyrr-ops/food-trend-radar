#!/usr/bin/env python3
"""Low-frequency credential probe; success does not prove session renewal."""
import fcntl
import hashlib
import json
import os
import pathlib
import time
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(os.environ.get('RADAR_DATA_ROOT', '/opt/food-trend-radar/data'))
TARGETS = [('so.xiaohongshu.com', '/api/sns/web/v2/search/notes'),
           ('edith.xiaohongshu.com', '/api/sns/web/v1/feed')]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def alert_transition(previous, fingerprint, results):
    same = previous.get('credential_hash') == fingerprint
    success = len(results) == 2 and all(r.get('success') for r in results)
    # A generic 403 may be a WAF rejection, not an expired login.
    auth_failed = any(r.get('code') in (-100, '-100') or r.get('http') == 401 for r in results)
    count = (previous.get('auth_failures', 0) if same else 0) + 1 if auth_failed else 0
    attempted = bool(previous.get('alert_attempted')) and not success
    return {'auth_failures': count, 'alert_attempted': attempted}, count >= 2 and not attempted


def save_state(path, state):
    tmp = path.with_suffix('.next.json')
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(state, output)
    os.replace(str(tmp), str(path))


def main():
    folder = ROOT / 'xhs-credential-health'
    folder.mkdir(mode=0o700, exist_ok=True)
    with open(str(folder / 'check.lock'), 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state_file = folder / 'status.json'
        try:
            state = json.loads(state_file.read_text())
        except (OSError, ValueError):
            state = {}
        try:
            raw = (ROOT / 'secrets/xiaohongshu-requests.json').read_bytes()
            records = json.loads(raw)
            fingerprint = hashlib.sha256(raw).hexdigest()
            selected = []
            for host, path in TARGETS:
                record = next(r for r in records if urllib.parse.urlparse(r['url']).hostname == host
                              and urllib.parse.urlparse(r['url']).path == path)
                assert urllib.parse.urlparse(record['url']).scheme == 'https'
                assert isinstance(record['headers'], dict) and isinstance(record['body'], str)
                json.loads(record['body'])
                selected.append(record)
        except (OSError, ValueError, KeyError, TypeError, StopIteration, AssertionError):
            print('xhs-check configuration_missing_or_invalid', flush=True)
            return
        now = int(time.time())
        same = state.get('credential_hash') == fingerprint
        if same and now < state.get('next_attempt_at', 0):
            return
        results = []
        blocked = False
        cooldown = 600
        opener = urllib.request.build_opener(NoRedirect())
        for index, record in enumerate(selected):
            if index:
                time.sleep(4)
            headers = {k: v for k, v in record['headers'].items()
                       if k.lower() not in ['host', 'content-length', 'accept-encoding', 'connection']}
            result = {'endpoint': TARGETS[index][1]}
            try:
                request = urllib.request.Request(record['url'], data=record['body'].encode(), headers=headers, method='POST')
                with opener.open(request, timeout=20) as response:
                    data = json.loads(response.read(5000001))
                    result.update(http=response.status, code=data.get('code'), success=data.get('success') is True and data.get('code') == 0)
                    result['sets_cookie'] = bool(response.headers.get_all('Set-Cookie'))
                    blocked = not result['success']
            except urllib.error.HTTPError as error:
                result.update(http=error.code, success=False)
                blocked = error.code in [301, 302, 303, 307, 308, 400, 401, 403, 406, 461, 471]
                if error.code == 429:
                    cooldown = 3600
                error.close()
            except (ValueError, TypeError, AttributeError):
                result.update(success=False, error='INVALID_RESPONSE')
                blocked = True
            except Exception:
                result.update(success=False, error='NETWORK_ERROR')
            results.append(result)
            if not result['success']:
                break
        success = len(results) == 2 and all(r['success'] for r in results)
        alert, should_alert = alert_transition(state, fingerprint, results)
        if alert['auth_failures'] >= 2:
            cooldown = 3600  # Continue checking for recovery without hammering a failed login.
        state = {**alert, 'credential_hash': fingerprint, 'checked_at': now, 'success': success,
                 'blocked': blocked, 'next_attempt_at': now + cooldown,
                 'last_success_at': now if success else (state.get('last_success_at') if same else None),
                 'results': results, 'note': 'Probe only; session renewal is not confirmed.'}
        if should_alert:
            # Persist before sending: a timeout/restart must never duplicate an SMS.
            state['alert_attempted'] = True
            state['alert_status'] = 'pending'
            save_state(state_file, state)
            try:
                result = subprocess.run([
                    '/opt/food-trend-radar/node-v22.22.1-linux-x64/bin/node',
                    str(pathlib.Path(__file__).with_name('credential-alert.mjs')),
                ], capture_output=True, text=True, timeout=35, check=False)
                state['alert_status'] = 'submitted' if result.returncode == 0 else 'failed_or_unknown'
            except (OSError, subprocess.TimeoutExpired):
                state['alert_status'] = 'failed_or_unknown'
            print('credential-alert ' + state['alert_status'], flush=True)
        save_state(state_file, state)
        print(json.dumps({k: v for k, v in state.items() if k != 'credential_hash'}), flush=True)

if __name__ == '__main__':
    os.umask(0o077)
    main()
