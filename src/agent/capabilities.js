// What the configured model supports, so the agent only asks for features the model accepts.
// Adaptive thinking and effort return a 400 on models without them (e.g. claude-sonnet-4-5).

// Used when the Models API can't be reached (e.g. a gateway that doesn't pass it through).
// These model families accept both thinking: { type: "adaptive" } and output_config.effort.
const KNOWN_ADAPTIVE = /^claude-(opus-4-[6-9]|opus-5|sonnet-4-6|sonnet-5|fable-5|mythos-5)/;
const EFFORT_LEVELS = ['low', 'medium', 'high'];

// capabilities: the `capabilities` object of a Models API ModelInfo (or null if not reported).
export function supportFromCapabilities(capabilities) {
  return {
    adaptiveThinking: Boolean(capabilities?.thinking?.types?.adaptive?.supported),
    effortLevels: capabilities?.effort?.supported
      ? EFFORT_LEVELS.filter((level) => capabilities.effort[level]?.supported)
      : [],
  };
}

export function supportFromModelId(model) {
  const known = KNOWN_ADAPTIVE.test(model);
  return { adaptiveThinking: known, effortLevels: known ? [...EFFORT_LEVELS] : [] };
}

// Asks the Models API (free; it doesn't use tokens) and falls back to the built-in list.
export async function modelSupport(client, model) {
  try {
    const info = await client.models.retrieve(model);
    if (info.capabilities) return { ...supportFromCapabilities(info.capabilities), source: 'Models API' };
  } catch {
    // unreachable or unknown to the gateway: use the built-in list below
  }
  return { ...supportFromModelId(model), source: 'built-in list' };
}
