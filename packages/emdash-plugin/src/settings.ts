import type { StatusConfig } from '@statusbeam/core'
import type { PluginContext } from 'emdash/plugin'
import { validateConfig } from '@statusbeam/core'

/**
 * The plain settings key that holds the monitor configuration as YAML.
 *
 * Seam for T008: it adds plugin-only validation, encrypted secret fields, and
 * the admin error state, and gates each run on them. Until then the scheduled
 * run only needs "a valid configuration, or nothing".
 */
export const CONFIG_SETTINGS_KEY = 'config'

/**
 * Read and validate the configuration with core's schema (one bridge call).
 * Returns `null` for an absent or invalid configuration: callers then check
 * nothing and write nothing, so no monitor's status changes.
 */
export async function readConfig(ctx: Pick<PluginContext, 'settings'>): Promise<StatusConfig | null> {
  const yaml = await ctx.settings.get<string>(CONFIG_SETTINGS_KEY)
  if (typeof yaml !== 'string' || yaml.trim() === '') {
    return null
  }
  const validation = validateConfig(yaml)
  return validation.ok ? validation.config : null
}
