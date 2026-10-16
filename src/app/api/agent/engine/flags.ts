/** Env flags that gate registry entries. Read on every call so a test or a restart-free config
 *  change takes effect. */

/** Computer-vision detectors are parked until a claim type needs them. */
export const isCvEnabled = (): boolean => process.env.GEOAGENT_ENABLE_CV === '1'

/** The offline stub provider and its SSE-contract fixture operation (ISS-111). */
export const allowStub = (): boolean => process.env.AGENT_ALLOW_STUB === '1'
