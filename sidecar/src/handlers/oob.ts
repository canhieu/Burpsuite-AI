import { newId, newSecret } from "../util.js"
import type { HandlerGroup } from "./types.js"

export function oobHandlers(): HandlerGroup {
  return {
    "oob.session": () => {
      const clientId = newId("c_")
      const secretKey = newSecret(24)
      const sub = `${newId("").toLowerCase()}.${clientId}`
      return {
        clientId,
        secretKey,
        payloads: {
          dns: `${sub}.oob.local`,
          http: `http://${sub}.oob.local`,
          https: `https://${sub}.oob.local`,
        },
        pollToken: newSecret(32),
      }
    },
    "oob.poll": () => ({ interactions: [] }),
  }
}
