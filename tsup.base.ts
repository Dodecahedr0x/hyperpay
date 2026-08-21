import { defineConfig, type Options } from 'tsup'

export function packageConfig(options: Options) {
  return defineConfig({
    format: ['esm'],
    dts: {
      compilerOptions: {
        composite: false,
        incremental: false,
      },
    },
    clean: true,
    sourcemap: true,
    target: 'es2022',
    bundle: false,
    treeshake: true,
    external: [/^@magicblock-labs\//, 'react', 'react-dom', 'react/jsx-runtime'],
    ...options,
  })
}
