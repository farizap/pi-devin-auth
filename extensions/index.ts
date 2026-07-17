/**
 * pi extension entry point for the Devin (Cognition) provider.
 *
 * Registers the `devin` provider with pi's ExtensionAPI, wiring up:
 *  - OAuth login via Windsurf's browser sign-in flow (`loginDevin`)
 *  - A no-op token refresh (Windsurf api_keys are long-lived)
 *  - Live model catalog fetch from Cognition's GetCascadeModelConfigs
 *    after login, filtered to 11 wanted model families
 *  - `/devin-refresh` command to manually re-fetch the catalog
 *  - `/devin-status` command to check auth state
 *  - `session_start` auto-fetch when already logged in
 *  - Streaming chat completions through Devin Cloud (`streamDevin`)
 *
 * The provider uses `streamSimple` — no background proxy. All routing
 * and auth are handled internally via the OAuth-issued api_key.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type {
    Api,
    Model,
    OAuthCredentials,
    OAuthLoginCallbacks,
} from '@earendil-works/pi-ai';
import { streamDevin } from '../src/stream.js';
import { loginDevin } from '../src/oauth/login.js';
import { buildLiveModels, FALLBACK_MODELS, DEFAULT_HOST } from '../src/models.js';
import { getCachedCatalog, clearCachedCatalog } from '../src/cloud-direct/catalog.js';
import { DEFAULT_REGION } from '../src/oauth/types.js';

const PROVIDER_ID = 'devin';
const PROVIDER_NAME = 'Devin (Cognition)';
const OAUTH_NAME = 'Devin (Cognition / Windsurf)';
const API_IDENTIFIER = 'devin-cloud';
// pi requires baseUrl when models are defined, even with streamSimple.
// streamSimple ignores this — it routes internally — but the field must be present.
const PLACEHOLDER_BASE_URL = DEFAULT_HOST;

let _pi: ExtensionAPI | null = null;

function registerDevinProvider(pi: ExtensionAPI, models: typeof FALLBACK_MODELS): void {
    pi.registerProvider(PROVIDER_ID, {
        name: PROVIDER_NAME,
        api: API_IDENTIFIER,
        baseUrl: PLACEHOLDER_BASE_URL,
        models,
        oauth: {
            name: OAUTH_NAME,
            async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
                const credentials = await loginDevin(callbacks, DEFAULT_REGION);
                if (_pi) {
                    try {
                        clearCachedCatalog();
                        const catalog = await getCachedCatalog(
                            credentials.access,
                            DEFAULT_HOST,
                        );
                        const liveModels = buildLiveModels(catalog);
                        registerDevinProvider(_pi, liveModels);
                    } catch {
                        // keep static models if catalog fetch fails
                    }
                }
                return credentials;
            },
            async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
                return credentials;
            },
            getApiKey(credentials: OAuthCredentials): string {
                return credentials.access;
            },
            modifyModels(models: Model<Api>[]): Model<Api>[] {
                return models;
            },
        },
        streamSimple: streamDevin,
    });
}

export default async function (pi: ExtensionAPI): Promise<void> {
    _pi = pi;

    registerDevinProvider(pi, FALLBACK_MODELS);

    pi.on('session_start', async (_event, ctx) => {
        try {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            if (apiKey && _pi) {
                const catalog = await getCachedCatalog(apiKey, DEFAULT_HOST);
                const liveModels = buildLiveModels(catalog);
                registerDevinProvider(_pi, liveModels);
            }
        } catch {
            // keep static models
        }
    });

    pi.registerCommand('devin-refresh', {
        description: 'Refresh Devin model catalog from Cognition',
        handler: async (_args, ctx) => {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            if (!apiKey) {
                ctx.ui.notify(
                    'Devin: not signed in. Run /login devin',
                    'warning',
                );
                return;
            }
            clearCachedCatalog();
            try {
                const catalog = await getCachedCatalog(apiKey, DEFAULT_HOST);
                const liveModels = buildLiveModels(catalog);
                registerDevinProvider(pi, liveModels);
                ctx.ui.notify(
                    `Devin: refreshed ${liveModels.length} models.`,
                    'info',
                );
            } catch (e) {
                ctx.ui.notify(
                    `Devin: refresh error - ${e instanceof Error ? e.message : String(e)}`,
                    'error',
                );
            }
        },
    });

    pi.registerCommand('devin-status', {
        description: 'Show Devin auth status',
        handler: async (_args, ctx) => {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            ctx.ui.notify(
                apiKey ? 'Devin: authenticated' : 'Devin: not signed in. Run /login devin',
                apiKey ? 'info' : 'warning',
            );
        },
    });

    pi.on('session_shutdown', async () => {
        _pi = null;
    });
}
