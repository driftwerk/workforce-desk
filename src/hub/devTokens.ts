// The tokens the browser preview and tests reach hubs with. Only outside
// the app: there is no native side there to hold them. In the app this is
// never filled, and nothing reads it (see ./net.ts).

const tokens = new Map<string, string>();

/** Hub `id`'s token, for the preview or a test. */
export const setDevToken = (id: string, token: string): void => void tokens.set(id, token);

export const devToken = (id: string): string => tokens.get(id) ?? "";
