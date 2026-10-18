import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxInject: `import React from 'react'`,
  },
  test: {
    environment: 'node',
  },
})
