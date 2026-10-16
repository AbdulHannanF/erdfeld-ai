import { selfCheckJudge } from './judge.mjs'
const r = await selfCheckJudge()
console.log(JSON.stringify({ passed: r.passed, total: r.total }))
process.exit(r.passed === r.total ? 0 : 1)
