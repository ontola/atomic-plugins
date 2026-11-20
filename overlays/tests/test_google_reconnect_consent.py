"""Fresh consent for independent Google connections; no scope/API policy changes."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from generate_identity_catalog_fixtures import ROOT, compose, platform_config

BEFORE = ROOT/'catalog/2026-11-20-authorization-help.json'
AFTER = ROOT/'catalog/2026-11-20-google-reconnect-consent.json'
SCHEMES = {'google-keep':'googleKeepOAuth', 'google-calendar':'googleOffline'}

class GoogleReconnectConsentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cache = Path(cls.tmp.name)
        cls.before = json.loads(BEFORE.read_text())
        cls.after = json.loads(AFTER.read_text())

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def test_only_selected_google_providers_gain_a_companion_overlay(self):
        expected = copy.deepcopy(self.before)
        for provider in SCHEMES:
            previous = platform_config(provider, expected)
            current = platform_config(provider, self.after)
            self.assertEqual(previous['overlays'], current['overlays'][:-1])
            self.assertIn('reconnect-consent-', current['overlays'][-1])
            previous['overlays'] = current['overlays']
        self.assertEqual(self.after, expected)

    def test_only_prompt_parameter_changes_in_each_composed_api(self):
        for provider, scheme_name in SCHEMES.items():
            with self.subTest(provider=provider):
                previous, _ = compose(provider, self.cache, self.before)
                current, _ = compose(provider, self.cache, self.after)
                scheme = current['components']['securitySchemes'][scheme_name]
                parameters = scheme['x-oauth-authentication-details']['authorizationCode']['profile']['parameters']
                fixed = [(p['parameter']['name'],p['value']) for p in parameters]
                self.assertEqual(fixed.count(('access_type','offline')), 1)
                self.assertEqual(fixed.count(('prompt','consent')), 1)
                prompt = parameters.pop()
                self.assertEqual(prompt['parameter']['schema'], {'type':'string','enum':['consent']})
                self.assertEqual(scheme['x-oauth-authentication-details']['authorizationCode']['profile']['tokenIssuance']['refreshToken']['presence'] if provider=='google-calendar' else scheme['x-oauth-authentication-details']['authorizationCode']['tokenIssuance']['refreshToken']['presence'], 'conditional')
                self.assertEqual(current, previous)
                if provider == 'google-calendar':
                    self.assertEqual(current['components']['securitySchemes']['googleOnline'], previous['components']['securitySchemes']['googleOnline'])
                else:
                    self.assertIn('x-oauth-authorization-help', scheme)

if __name__ == '__main__': unittest.main()
