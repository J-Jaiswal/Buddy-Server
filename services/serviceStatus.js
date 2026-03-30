export const serviceStatus = {
  groq: { ok: false, error: null },
  tts: { ok: false, error: null },
  mongo: { ok: false, error: null },
};

export function setStatus(service, ok, error = null) {
  serviceStatus[service] = { ok, error };
}
