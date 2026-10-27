// Lets `vite dev` run the UI in a plain browser against a running local hub,
// for checking screens without the app: open
// http://localhost:5183/?hub=<gateway url>&admin=<gateway token>&device=<device token>
// Only reachable from development builds.

const params = (() => {
  const keys = ["hub", "admin", "device"] as const;
  const fromUrl = new URLSearchParams(location.search);
  const read = (k: string) => {
    const v = fromUrl.get(k);
    try {
      if (v) sessionStorage.setItem(`desk.dev.${k}`, v);
      return v ?? sessionStorage.getItem(`desk.dev.${k}`);
    } catch {
      return v;
    }
  };
  return Object.fromEntries(keys.map((k) => [k, read(k)])) as Record<(typeof keys)[number], string | null>;
})();

const need = (k: keyof typeof params): string => {
  const v = params[k];
  if (!v) throw new Error(`browser preview needs ?${k}= in the URL`);
  return v;
};

let settings = {
  theme: "system",
  tuple: false,
  plan: null as string | null,
  defaultVoice: { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" },
  agentVoices: {},
  voice: false,
  voiceEngine: "cascade",
};

export async function devInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const answer = (v: unknown) => v as T;
  switch (cmd) {
    case "hub_connection":
      return answer({ url: need("hub"), token: need("admin") });
    case "hubs_list":
      return answer([{ id: "local", label: "This Mac", url: need("hub"), local: true, token: need("device") }]);
    case "settings_load":
      return answer(settings);
    case "settings_save":
      settings = args?.settings as typeof settings;
      return answer(undefined);
    case "themes_list":
      return answer([]);
    default:
      // Voice and Tuple live in the app process; in the preview they are off.
      if (cmd === "voice_status") return answer({ state: "off" });
      if (/^(voice|tuple)_/.test(cmd)) return answer(undefined);
      throw new Error(`${cmd} is only available in the Desk app`);
  }
}
