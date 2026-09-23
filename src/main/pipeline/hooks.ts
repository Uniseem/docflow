import { defaultComposeOptions } from '../pdf/compose'
import type { PdfWorkerHost } from '../pdf/worker-host'
import type { DocumentLibrary } from '../library/library'
import type { SettingsStore } from '../settings/settings'
import type { TranslationPools } from '../translate/pool'
import { fakeProvider } from '../translate/fake'
import { withMockProviderUrl } from '../../shared/presets'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { DocumentManifest, ProviderConfig } from '../../shared/types'
import { analyzeStage } from './stages/analyze'
import { composeStage } from './stages/compose'
import { inspectStage } from './stages/inspect'
import { translateStage } from './stages/translate'
import { verifyStage } from './stages/verify'
import { bundledFonts, type PipelineHooks } from './run'

export function createPipelineHooks(input: {
  library: DocumentLibrary
  settings: SettingsStore
  pools: TranslationPools
  analyze: PdfWorkerHost
  compose: PdfWorkerHost
  env?: NodeJS.Dict<string>
  /** Directory holding the bundled Noto Sans SC fonts. */
  fontsDir?: string
  onChanged?: (manifest: DocumentManifest) => void
}): PipelineHooks {
  const env = input.env ?? process.env
  return {
    ...(input.onChanged ? { onChanged: input.onChanged } : {}),
    inspect: (path, signal) => inspectStage(input.analyze, path, signal),
    analyze: (path, pages, signal) => analyzeStage(input.analyze, path, pages, signal),
    translate: async ({ analysis, manifest, workDir, signal, onProgress }) => {
      const provider = resolveProvider(
        input.settings.snapshot.providers,
        manifest.translator.providerId,
        env,
      )
      return translateStage({
        analysis,
        manifest,
        workDir,
        provider,
        pools: input.pools,
        signal,
        onProgress,
        onEvent: async (event) => {
          await input.library.events.append(manifest.id, { stage: 'translate', ...event })
        },
      })
    },
    compose: async (args) => {
      const result = (await composeStage(
        input.compose,
        {
          sourcePath: args.sourcePath,
          monoPath: args.monoPath,
          dualPath: args.dualPath,
          analysis: args.analysis,
          translations: args.translations,
          fonts: args.fonts,
          options: { ...defaultComposeOptions(), minFontScale: args.minFontScale },
        },
        args.analysis.pages,
        args.signal,
      )) as Awaited<ReturnType<PipelineHooks['compose']>>
      return result
    },
    verify: (args) =>
      verifyStage(
        input.analyze,
        {
          monoPath: args.monoPath,
          dualPath: args.dualPath,
          pages: args.pages,
          writtenPages: args.writtenPages,
        },
        args.signal,
      ),
    fonts: bundledFonts(input.fontsDir),
    bilingual: () => input.settings.snapshot.pdf.bilingual,
    minFontScale: () => input.settings.snapshot.pdf.minFontScale,
  }
}

function resolveProvider(
  providers: ProviderConfig[],
  id: string,
  env: NodeJS.Dict<string>,
): ProviderConfig {
  const found = providers.find((item) => item.id === id)
  if (found) return withMockProviderUrl(found, env.DOCFLOW_MOCK_PROVIDER_URL)
  if (env.DOCFLOW_FAKE_PROVIDERS === '1') return fakeProvider()
  throw new UserError(ERROR_CODES.not_found, '找不到这个翻译服务商。')
}
