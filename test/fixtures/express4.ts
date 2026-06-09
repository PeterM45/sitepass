// The express4 npm alias (npm:express@^4) ships no types of its own and
// @types/express tracks v5, so present express@4 through the v5 typings: the
// surface the tests touch (app(), use, all, listen) is identical across the
// majors. The cast is confined to this fixture.
import { createRequire } from 'node:module'
import type express from 'express'

const require = createRequire(import.meta.url)

export default require('express4') as typeof express
