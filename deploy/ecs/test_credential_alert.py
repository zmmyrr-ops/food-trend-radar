import importlib.util
import pathlib
import unittest
spec = importlib.util.spec_from_file_location('probe', pathlib.Path(__file__).with_name('xhs-credential-check.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
class AlertTests(unittest.TestCase):
    def step(self, state, results, fingerprint='a'):
        alert, send = p.alert_transition(state, fingerprint, results)
        return dict(alert, credential_hash=fingerprint), send
    def test_two_failures_once_then_recovery(self):
        failure = [{'code': -100, 'success': False}]
        state, send = self.step({}, failure)
        self.assertFalse(send)
        state, send = self.step(state, failure)
        self.assertTrue(send)
        state['alert_attempted'] = True
        state, send = self.step(state, failure)
        self.assertFalse(send)
        state, send = self.step(state, [{'success': True}, {'success': True}])
        self.assertFalse(state['alert_attempted'])
        state, send = self.step(state, failure)
        self.assertFalse(send)
        _, send = self.step(state, failure)
        self.assertTrue(send)
    def test_non_auth_breaks_consecutive_failures(self):
        for result in [{'http': 403}, {'http': 429}, {'error': 'NETWORK_ERROR'}, {'code': -9999}]:
            state, _ = self.step({}, [{'code': -100}])
            state, send = self.step(state, [result])
            self.assertFalse(send)
            _, send = self.step(state, [{'code': -100}])
            self.assertFalse(send)
    def test_new_credential_requires_two_checks_without_duplicate_incident(self):
        state = {'credential_hash': 'a', 'auth_failures': 1}
        state, send = self.step(state, [{'http': 401}], 'b')
        self.assertFalse(send)
        state['alert_attempted'] = True
        _, send = self.step(state, [{'http': 401}], 'b')
        self.assertFalse(send)
if __name__ == '__main__':
    unittest.main()
