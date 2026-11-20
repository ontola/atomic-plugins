"""Keep cannot display a forced consent screen; retain only Calendar's prompt."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from generate_identity_catalog_fixtures import ROOT, compose, platform_config

BASE = ROOT/'catalog/2026-11-20-authorization-help.json'
CURRENT = ROOT/'catalog/2026-11-20-calendar-reconnect-consent.json'
HISTORICAL = ROOT/'catalog/2026-11-20-google-reconnect-consent.json'

class CalendarConsentOnlyTests(unittest.TestCase):
    def test_current_catalog_adds_only_calendar_consent_and_retains_keep_help(self):
        current = json.loads(CURRENT.read_text())
        expected = json.loads(BASE.read_text())
        calendar = platform_config('google-calendar', expected)
        selected = platform_config('google-calendar', current)
        self.assertEqual(selected['overlays'][:-1], calendar['overlays'])
        self.assertIn('reconnect-consent-', selected['overlays'][-1])
        calendar['overlays'] = selected['overlays']
        self.assertEqual(current, expected)
        self.assertFalse(any('reconnect-consent-' in url for url in platform_config('google-keep', current)['overlays']))

    def test_keep_is_api_identical_to_admin_help_profile_and_calendar_keeps_its_prompt(self):
        current = json.loads(CURRENT.read_text())
        base = json.loads(BASE.read_text())
        historical = json.loads(HISTORICAL.read_text())
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            keep, _ = compose('google-keep', cache, current)
            before, _ = compose('google-keep', cache, base)
            self.assertEqual(keep, before)
            scheme = keep['components']['securitySchemes']['googleKeepOAuth']
            self.assertIn('x-oauth-authorization-help', scheme)
            fixed = [(p['parameter']['name'],p['value']) for p in scheme['x-oauth-authentication-details']['authorizationCode']['profile']['parameters']]
            self.assertEqual(fixed, [('access_type','offline')])
            calendar, _ = compose('google-calendar', cache, current)
            approved, _ = compose('google-calendar', cache, historical)
            self.assertEqual(calendar, approved)
            params = calendar['components']['securitySchemes']['googleOffline']['x-oauth-authentication-details']['authorizationCode']['profile']['parameters']
            self.assertEqual([(p['parameter']['name'],p['value']) for p in params], [('access_type','offline'),('prompt','consent')])

if __name__ == '__main__': unittest.main()
