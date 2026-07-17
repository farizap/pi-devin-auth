/**
 * Drive a browser-based Windsurf sign-in via pi's `OAuthLoginCallbacks`.
 *
 * Flow:
 *   1. Build an Auth0 implicit-grant URL (`response_type=token`) pointing at
 *      Windsurf's SPA sign-in page with `redirect_uri=show-auth-token`. That
 *      special redirect tells the SPA to render the resulting access token in
 *      a `<code>` block on screen instead of redirecting away — the user
 *      copies it manually.
 *   2. `callbacks.onAuth({ url })` opens the browser.
 *   3. `callbacks.onPrompt(...)` collects the pasted token. That pasted value
 *      IS the Firebase ID token (the `access_token` from the OAuth fragment).
 *   4. `registerUser(pasted, region)` exchanges it for a long-lived API key.
 *   5. We wrap the key in `OAuthCredentials` and return it.
 *
 * Why manual paste instead of a loopback redirect? pi's `OAuthLoginCallbacks`
 * surface no way to spin up a local HTTP server or read a redirect — the only
 * inputs we get back are `onPrompt` (free text) and `onSelect` (pick from a
 * list). The `show-auth-token` redirect + manual paste is the same trick the
 * opencode-windsurf-auth CLI uses for headless / SSH environments, and it is
 * the only shape that fits pi's callback contract.
 */

import * as crypto from 'crypto';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import { registerUser } from './register-user.js';
import { DEFAULT_REGION, type WindsurfRegion } from './types.js';

/** One year in milliseconds — the API key is effectively non-expiring. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Build the Auth0 implicit-grant URL for Windsurf's SPA sign-in page.
 *
 * Mirrors the params the opencode-windsurf-auth flow sends:
 *   - `response_type=token`  -> Auth0 returns the access token in the URL
 *     fragment (implicit grant, no client secret).
 *   - `redirect_uri=show-auth-token` -> the SPA's special route that renders
 *     the token on-screen for manual copy instead of bouncing elsewhere.
 *   - `state` -> random UUID, guards CSRF on the browser round-trip. We do
 *     not validate it server-side (we never receive the redirect), but
 *     Auth0 requires it and echoing it back is good hygiene.
 *   - `prompt=login` -> force a fresh Auth0 login screen even if the user
 *     has an SSO session, so they can pick a different account.
 */
function buildSignInUrl(region: WindsurfRegion): string {
    const params = new URLSearchParams({
        response_type: 'token',
        client_id: region.oauthClientId,
        redirect_uri: 'show-auth-token',
        state: crypto.randomUUID(),
        prompt: 'login',
    });
    return `${region.website}/windsurf/signin?${params.toString()}`;
}

/**
 * Run the full Windsurf OAuth login through pi's `OAuthLoginCallbacks`.
 *
 * The returned `OAuthCredentials.access` is the Windsurf API key (not the
 * short-lived Firebase token — that is consumed by `registerUser` and
 * discarded). `refresh` is empty because Windsurf API keys do not expire;
 * `expires` is set one year out as a soft sentinel, not a hard expiry.
 *
 * `WindsurfRegistrationError` thrown by `registerUser` is allowed to
 * propagate — pi surfaces it to the user.
 */
export async function loginDevin(
    callbacks: OAuthLoginCallbacks,
    region: WindsurfRegion = DEFAULT_REGION,
): Promise<OAuthCredentials> {
    const url = buildSignInUrl(region);

    // Open the browser to the Auth0 sign-in page.
    callbacks.onAuth({ url });

    // Block until the user pastes the token rendered on the sign-in page.
    // This is the Firebase ID token (OAuth `access_token` from the fragment).
    const firebaseIdToken = await callbacks.onPrompt({
        message: 'Paste the token from the sign-in page:',
    });

    if (!firebaseIdToken) {
        throw new Error('No token pasted; cannot complete sign-in.');
    }

    // Exchange the Firebase token for a long-lived Windsurf API key.
    const result = await registerUser(firebaseIdToken.trim(), region);

    return {
        refresh: '',
        access: result.apiKey,
        expires: Date.now() + ONE_YEAR_MS,
    };
}
