#!/usr/bin/env node
/**
 * dump-npm-latest.mjs — 从 registry 读取本包的 latest 元数据，落到仓库根的
 * npm-latest.json。
 *
 * 由 .github/workflows/npm-publish.yml 的 dump-latest job 在正式版
 * （dist-tag=latest）发布后自动运行并回写 main；也可本地手动执行刷新快照。
 *
 * 只走 registry HTTP API（NPM_REGISTRY 环境变量可覆盖，默认 npmjs 官方源），
 * 不依赖 npm CLI，Windows / Linux / macOS 行为一致。内容对同一 latest 版本
 * 幂等（不记录 dump 时间戳），重复运行不产生 diff。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const registry = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// scoped 包名在 registry API 路径里需要把 / 编码为 %2f
const res = await fetch(`${registry}/${pkg.name.replace('/', '%2f')}`)
if (!res.ok) throw new Error(`registry request failed: ${res.status} ${res.statusText} (${registry})`)
const meta = await res.json()

const latest = meta['dist-tags']?.latest
if (latest === undefined) throw new Error(`${pkg.name}: no latest dist-tag on ${registry}`)
const versionMeta = meta.versions?.[latest]
if (versionMeta === undefined) throw new Error(`${pkg.name}: metadata for ${latest} missing on ${registry}`)

const dump = {
  name: pkg.name,
  latest,
  publishedAt: meta.time?.[latest] ?? null,
  dist: {
    tarball: versionMeta.dist?.tarball ?? null,
    integrity: versionMeta.dist?.integrity ?? null,
    unpackedSize: versionMeta.dist?.unpackedSize ?? null,
  },
}

const out = new URL('../npm-latest.json', import.meta.url)
writeFileSync(out, JSON.stringify(dump, null, 2) + '\n')
console.log(`ok: npm-latest.json — ${pkg.name}@${latest} (published ${dump.publishedAt})`)
