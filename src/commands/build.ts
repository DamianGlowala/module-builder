import { existsSync, promises as fsp } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, dirname, extname, join, normalize, resolve } from 'pathe'
import { filename } from 'pathe/utils'
import { readPackageJSON } from 'pkg-types'
import { parse } from 'tsconfck'
import type { TSConfig } from 'pkg-types'
import { defu } from 'defu'
import { createJiti } from 'jiti'
import { anyOf, createRegExp } from 'magic-regexp'
import { consola } from 'consola'
import type { NuxtModule } from '@nuxt/schema'
import { findExports, findTypeExports } from 'mlly'
import type { ESMExport } from 'mlly'
import { defineCommand } from 'citty'

import { name, version } from '../../package.json'
import { resolveCwdArg, sharedArgs } from './_shared'

export default defineCommand({
  meta: {
    name: 'build',
    description: 'Build module for distribution',
  },
  args: {
    ...sharedArgs,
    outDir: {
      type: 'string',
      default: 'dist',
      description: 'Build directory',
    },
    sourcemap: {
      type: 'boolean',
      default: false,
      description: 'Generate sourcemaps',
    },
    watch: {
      type: 'boolean',
      default: false,
      description: 'Watch src and rebuild for development',
    },
  },
  async run(context) {
    const cwd = resolveCwdArg(context.args)

    const jiti = createJiti(cwd)

    // Production build using rolldown + mkdist
    const { build } = await import('rolldown')
    const { dts } = await import('rolldown-plugin-dts')
    const { mkdist } = await import('mkdist')

    const pkg = await readPackageJSON(cwd)
    const pkgBuildEntries = ((pkg as any)?.build?.entries as string[] | undefined) || []

    // Collect all module entry points (from build config + package.json build.entries)
    const moduleInputs: Record<string, string> = {
      module: resolve(cwd, 'src/module'),
    }
    for (const entry of pkgBuildEntries) {
      const entryPath = resolve(cwd, entry)
      const entryName = filename(entryPath) || basename(entryPath, extname(entryPath))
      moduleInputs[entryName] = entryPath
    }

    const runtimeSrcDir = resolve(cwd, 'src/runtime')
    const runtimeOutDir = resolve(cwd, context.args.outDir, 'runtime')
    const RUNTIME_RE = createRegExp(anyOf('runtime').and(anyOf('/', '\\')))

    const firstEntryPath = Object.values(moduleInputs)[0]!
    const mergedCompilerOptions = defu({
      noEmit: false,
      paths: {
        '#app/nuxt': ['./node_modules/nuxt/dist/app/nuxt'],
      },
    }, await loadTSCompilerOptions(firstEntryPath))

    const outDir = resolve(cwd, context.args.outDir)

    // Build runtime directory with mkdist first so files exist for rolldown resolution
    await mkdist({
      rootDir: cwd,
      srcDir: runtimeSrcDir,
      distDir: runtimeOutDir,
      addRelativeDeclarationExtensions: true,
      declaration: true,
      ext: 'js',
      pattern: [
        '**',
        '!**/*.stories.{js,cts,mts,ts,jsx,tsx}', // ignore storybook files
        '!**/*.{spec,test}.{js,cts,mts,ts,jsx,tsx}', // ignore tests
      ],
      esbuild: {
        jsxImportSource: 'vue',
        jsx: 'automatic',
        jsxFactory: 'h',
      },
      typescript: {
        compilerOptions: await loadTSCompilerOptions(runtimeSrcDir),
      },
    })

    await build({
      input: moduleInputs,
      platform: 'node',
      external: [
        /dist[\\/]runtime[\\/]/,
        '@nuxt/schema',
        '@nuxt/schema-nightly',
        '@nuxt/schema-edge',
        '@nuxt/kit',
        '@nuxt/kit-nightly',
        '@nuxt/kit-edge',
        '#app',
        '#app/nuxt',
        'nuxt',
        'nuxt-nightly',
        'nuxt-edge',
        'nuxt3',
        'vue',
        'vue-demi',
      ],
      plugins: [
        // Add extension for imports of runtime files in build
        {
          name: 'nuxt-module-builder:runtime-externals',
          async resolveId(id, importer) {
            if (!RUNTIME_RE.test(id))
              return
            
            const resolved = await this.resolve(id, importer, { skipSelf: true })

            if (!resolved)
              return

            const normalizedId = normalize(resolved.id)
            const normalizedSrcDir = normalize(runtimeSrcDir)
            if (!normalizedId.startsWith(normalizedSrcDir))
              return

            // slice(+1) strips the leading separator after the srcDir
            const relPath = normalizedId.slice(normalizedSrcDir.length + 1)
            const relDir = dirname(relPath)
            const entryName = filename(normalizedId) || basename(normalizedId, extname(normalizedId))
            // mkdist outputs .js files; compute the path directly (files exist since mkdist ran first)
            return {
              external: true,
              id: join(runtimeOutDir, relDir, `${entryName}.js`),
            }
          },
        },
        dts({
          cwd,
          sourcemap: context.args.sourcemap,
        }),
      ],
      output: {
        dir: outDir,
        entryFileNames: '[name].mjs',
        format: 'esm',
        sourcemap: context.args.sourcemap,
      },
    })

    // Load module meta
    const moduleEntryPath = resolve(outDir, 'module.mjs')
    const moduleFn = await jiti.import<NuxtModule<Record<string, unknown>>>(pathToFileURL(moduleEntryPath).toString(), { default: true }).catch((err) => {
      consola.error(err)
      consola.error('Cannot load module. Please check dist:', moduleEntryPath)
      return null
    })

    if (moduleFn) {
      const moduleMeta = await moduleFn.getMeta?.() || {}

      // Enhance meta using package.json
      if (pkg) {
        if (!moduleMeta.name) {
          moduleMeta.name = pkg.name
        }
        if (!moduleMeta.version) {
          moduleMeta.version = pkg.version
        }
      }

      // Add module builder metadata
      moduleMeta.builder = {
        [name]: version,
        rolldown: await readPackageJSON('rolldown').then(r => r.version).catch(() => 'unknown'),
      }

      // Write meta
      const metaFile = resolve(outDir, 'module.json')
      await fsp.writeFile(metaFile, JSON.stringify(moduleMeta, null, 2), 'utf8')
    }

    // Generate types
    await writeTypes(outDir, false)

    // Post-build warnings
    if (pkg?.types && !existsSync(resolve(cwd, pkg.types))) {
      consola.warn(`Please remove the \`types\` field from package.json as it is no longer required for Bundler TypeScript module resolution. Instead, you can use \`typesVersions\` to support subpath export types for Node10, if required.`)
    }
  },
})

async function writeTypes(distDir: string, isStub: boolean) {
  const dtsFile = resolve(distDir, 'types.d.mts')
  if (existsSync(dtsFile)) {
    return
  }

  const moduleReExports: ESMExport[] = []
  if (!isStub) {
    // Read generated module types
    const moduleTypesFile = resolve(distDir, 'module.d.mts')
    const moduleTypes = await fsp.readFile(moduleTypesFile, 'utf8').catch(() => '')
    const normalisedModuleTypes = moduleTypes
      // Replace `export { type Foo }` with `export { Foo }`
      .replace(/export\s*\{.*?\}/gs, match => match.replace(/\b(type|interface)\b/g, ''))
    for (const e of findExports(normalisedModuleTypes)) {
      moduleReExports.push(e)
    }
    for (const i of findTypeExports(normalisedModuleTypes)) {
      moduleReExports.push(i)
    }
  }

  const appShims: string[] = []
  const schemaShims: string[] = []
  const moduleImports: string[] = []
  const schemaImports: string[] = []
  const moduleExports: string[] = []

  const hasTypeExport = (name: string) => isStub || moduleReExports.find(exp => exp.names?.includes(name))

  if (!hasTypeExport('ModuleOptions')) {
    schemaImports.push('NuxtModule')
    moduleImports.push('default as Module')
    moduleExports.push(`export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`)
  }

  if (hasTypeExport('ModuleHooks')) {
    moduleImports.push('ModuleHooks')
    schemaShims.push('  interface NuxtHooks extends ModuleHooks {}')
  }

  if (hasTypeExport('ModuleRuntimeHooks')) {
    moduleImports.push('ModuleRuntimeHooks')
    appShims.push(`  interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}`)
  }

  if (hasTypeExport('ModuleRuntimeConfig')) {
    moduleImports.push('ModuleRuntimeConfig')
    schemaShims.push('  interface RuntimeConfig extends ModuleRuntimeConfig {}')
  }
  if (hasTypeExport('ModulePublicRuntimeConfig')) {
    moduleImports.push('ModulePublicRuntimeConfig')
    schemaShims.push('  interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}')
  }

  const dtsContents = `
  ${schemaImports.length ? `import type { ${schemaImports.join(', ')} } from '@nuxt/schema'` : ''}

${moduleImports.length ? `import type { ${moduleImports.join(', ')} } from './module.mjs'` : ''}

${appShims.length ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${moduleExports.length ? `\n${moduleExports.join('\n')}` : ''}
${isStub ? 'export * from "./module.mjs"' : ''}
${moduleReExports.filter(e => e.type === 'named' || e.type === 'default').map(e => `\nexport { ${e.names.map(n => (n === 'default' ? '' : 'type ') + n).join(', ')} } from '${e.specifier || './module.mjs'}'`).join('\n')}
${moduleReExports.filter(e => e.type === 'star').map(e => `\nexport * from '${e.specifier || './module.mjs'}'`).join('\n')}
`.trim().replace(/[\n\r]{3,}/g, '\n\n') + '\n'

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
}

async function loadTSCompilerOptions(path: string): Promise<NonNullable<TSConfig['compilerOptions']>> {
  const config = await parse(path)
  const resolvedCompilerOptions = config?.tsconfig.compilerOptions || {}

  // TODO: this should probably be ported to tsconfck?
  for (const { tsconfig, tsconfigFile } of config.extended || []) {
    for (const alias in tsconfig.compilerOptions?.paths || {}) {
      resolvedCompilerOptions.paths[alias] = resolvedCompilerOptions.paths[alias].map((p: string) => {
        if (!/^\.{1,2}(?:\/|$)/.test(p)) return p

        return resolve(dirname(tsconfigFile), p)
      })
    }
  }

  return resolvedCompilerOptions
}
