/**
 * Refuse inference while the company route still pins the unconfigured placeholder.
 *
 * The generated provider overlay keeps the application bootable before a model is chosen, so it pins
 * {@link UNCONFIGURED_MODEL_ID}. No endpoint serves that id: sending it produces a meaningless 404 and burns a
 * request. This module is written into the launch directory and inserted by the same overlay, where it refuses a
 * request for that model through the documented `llm/stream` waterfall and names the action the user needs.
 * @module @deepseek-ai/dsh-vscode/host/model-gate
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The plugin source the overlay inserts.
 *
 * It is written as a module instead of imported because the DSH application boots in another process, where this
 * package's build output is not on the module path.
 */
export const MODEL_GATE_SOURCE = `export const name = 'company-unconfigured-model-gate'

/**
 * Refuse a stream request for the deployment placeholder.
 * @param ctx - plugin context owning the listener.
 * @param config - the model id the deployment has not chosen yet.
 */
export function apply(ctx, config) {
  const placeholder = config.model
  ctx.on('llm/stream', (options, next) => {
    if (options.model !== placeholder) return next()
    throw new Error(
      'DSH has no model selected for the company endpoint. Open Models, fetch the available models, and choose one before sending a message.',
    )
  })
}
`

/**
 * Write the gate module into one launch directory.
 * @param launchDir - absolute directory this activation owns.
 * @returns the absolute path of the written module.
 */
export function writeModelGate(launchDir: string): string {
  const path = join(launchDir, 'model-gate.mjs')
  writeFileSync(path, MODEL_GATE_SOURCE)
  return path
}
