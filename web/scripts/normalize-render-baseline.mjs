#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
/** Instrument one frozen M5 build without modifying its renderer, shaders, or input files. */
import { createHash } from 'node:crypto';
import { cp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} requires a path.`);
  return args[at + 1];
}
if (args.includes('--help')) {
  console.log(
    'node scripts/normalize-render-baseline.mjs [--source /tmp/espresso-m5-baseline-dist] [--output /tmp/espresso-m5-baseline-bench-dist]',
  );
  process.exit(0);
}
const source = resolve(option('--source', '/tmp/espresso-m5-baseline-dist'));
const output = resolve(option('--output', '/tmp/espresso-m5-baseline-bench-dist'));
if (source === output || output.startsWith(source + sep) || source.startsWith(output + sep))
  throw new Error('Source and output must be separate directories, neither inside the other.');
const asset = 'assets/PuckView-BwAkJHbz.js';
const expectedSha256 = '9765c4a206c46fe693e8929b8a81ab48720780fec34de6bc7ae74a82d565ab26';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const original = await readFile(join(source, asset), 'utf8');
if (hash(original) !== expectedSha256)
  throw new Error(
    'Unknown baseline asset: SHA-256 does not match the frozen M5 build. No files copied.',
  );
try {
  await stat(output);
  throw new Error(
    'Output already exists; choose a fresh directory. Input and previous results remain untouched.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const helperPath = fileURLToPath(new URL('../src/explore/benchmark.ts', import.meta.url));
const helperSource = await readFile(helperPath, 'utf8');
const helper = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const oldBenchmark =
  'let de=()=>{cancelAnimationFrame(ie),ae&&d(oe*1e3/Math.max(1,performance.now()-ae)),ae=0,p(!1)},fe=e=>{re||document.hidden?de():(ae||=e,f.position.applyAxisAngle(new q(0,1,0),.006),f.lookAt(m.target),L(),oe++,e-ae<3e3?ie=requestAnimationFrame(fe):de())};s.current=()=>{ae||document.hidden||(oe=0,p(!0),ie=requestAnimationFrame(fe))};';
const instrumentation = `
let __pwBench=null;
const __pwHost=e.closest('.puck-view');
const __pwPublish=report=>{
  if(!__pwHost)return;
  const json=JSON.stringify(report);
  __pwHost.setAttribute('data-render-benchmark',json);
  let details=__pwHost.querySelector('.render-benchmark-result');
  if(!details){details=document.createElement('details');details.className='render-benchmark-result';__pwHost.append(details);}
  details.replaceChildren();
  const summary=document.createElement('summary');summary.textContent='Benchmark report: '+report.status;
  const button=document.createElement('button');button.type='button';button.textContent='Download benchmark JSON';
  button.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='puckworks-baseline-benchmark-'+report.environment.particleCount+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const pre=document.createElement('pre');pre.textContent=JSON.stringify(report,null,2);pre.style.maxHeight='20rem';pre.style.overflow='auto';
  details.append(summary,button,pre);
};
const __pwConfig=()=>{const gl=r.getContext(),rect=e.getBoundingClientRect();return{
  particleCount:t.radiiMm.length,renderPath:'analytic-exact',sphereQuality:'exact sphere silhouette and surface depth',
  networkVisible:a.current.showNetwork,cutFraction:a.current.cut,
  cssWidthPx:rect.width,cssHeightPx:rect.height,drawingBufferWidthPx:gl.drawingBufferWidth,drawingBufferHeightPx:gl.drawingBufferHeight,
  devicePixelRatio:window.devicePixelRatio,rendererPixelRatio:r.getPixelRatio(),
  camera:{position:[f.position.x,f.position.y,f.position.z],target:[m.target.x,m.target.y,m.target.z],verticalFovDeg:f.fov,orbitRadiansPerSecond:.36},
  webgl:__pwReadGL(gl),extraQuality:{meshMaxErrorPx:0,mesh16CountAtStart:0,mesh32CountAtStart:0,mesh64CountAtStart:0,mesh128CountAtStart:0,mesh256CountAtStart:0,analyticCountAtStart:t.radiiMm.length,markerParticle:a.current.selectedParticle,modelSeed:t.seed,warmupCamera:'fixed canonical pose; sampled orbit starts at zero',viewportWidthPx:window.innerWidth,viewportHeightPx:window.innerHeight}
}};
let de=reason=>{
  cancelAnimationFrame(ie);
  const b=__pwBench;__pwBench=null;ae=0;p(false);
  if(!b)return;
  if(reason)b.acc.cancel(reason);else if(b.acc.progress().phase!=='complete')b.acc.cancel('interrupted');
  const poll=b.timer.poll();b.gpu.push(...poll.samples.map(v=>v.elapsedMs));b.disjoint||=poll.disjoint;
  const report=b.acc.finish({supported:b.timer.supported,disjoint:b.disjoint,everyFrames:b.timer.everyFrames,samplesMs:b.gpu,pending:poll.pending});
  report.instrumentation={sourceAssetSha256:'${expectedSha256}',baselineRendererUnchanged:true,cameraResetAtSample:true,gpuQueriesOnlyDuringSample:true};
  report.frameRecords=b.records;
  b.timer.dispose();m.enabled=b.controlsEnabled;
  d(report.stats.meanFps);__pwPublish(report);
},fe=timestamp=>{
  const b=__pwBench;if(!b)return;
  if(re){de('disposed');return;}if(document.hidden){de('tab-hidden');return;}
  const gl=r.getContext(),rect=e.getBoundingClientRect();
  if(gl.isContextLost()){de('context-lost');return;}
  if(a.current.particleEy!==b.ey||a.current.selectedParticle!==b.selected||a.current.cut!==b.env.cutFraction||a.current.showNetwork!==b.env.networkVisible||!a.current.active||rect.width!==b.env.cssWidthPx||rect.height!==b.env.cssHeightPx||gl.drawingBufferWidth!==b.env.drawingBufferWidthPx||gl.drawingBufferHeight!==b.env.drawingBufferHeightPx||window.devicePixelRatio!==b.env.devicePixelRatio){de('configuration-changed');return;}
  if(b.started===null){b.started=timestamp;b.acc.start(timestamp);}
  const entersSample=b.acc.willStartSample(timestamp);
  if(entersSample)b.sampleStart=timestamp;
  const sampling=b.sampleStart!==null;
  f.position.fromArray(sampling?__pwOrbit(b.initial,b.target,timestamp-b.sampleStart,.36):b.initial);f.lookAt(m.target);
  const poll=b.timer.poll();b.gpu.push(...poll.samples.map(v=>v.elapsedMs));b.disjoint||=poll.disjoint;
  if(sampling)b.timer.begin(b.sampleFrame);
  const cpuStart=performance.now();L();const cpuEnd=performance.now();
  if(sampling){b.timer.end();b.sampleFrame++;}
  const progress=b.acc.recordFrame(timestamp,cpuEnd-cpuStart);
  b.records.push({rafTimestampMs:timestamp,elapsedRafMs:timestamp-b.started,phase:progress.phase,cpuStartMs:cpuStart,cpuEndMs:cpuEnd});
  if(progress.phase==='complete')de();else ie=requestAnimationFrame(fe);
};
s.current=()=>{
  if(__pwBench||document.hidden||re)return;
  __pwHost?.removeAttribute('data-render-benchmark');
  f.position.set(u*1.35,u*.9,u*1.6);m.target.set(0,0,0);f.lookAt(m.target);m.update();L();
  const env=__pwConfig(),timer=__pwGpu(r.getContext(),{everyFrames:4});
  __pwBench={env,timer,acc:__pwCreate({environment:env,targetFps:window.innerWidth<=700?30:60,warmupMs:1500,minWarmupFrames:30,sampleMs:5000}),initial:[...env.camera.position],target:[...env.camera.target],started:null,sampleStart:null,sampleFrame:0,gpu:[],disjoint:false,records:[],controlsEnabled:m.enabled,ey:a.current.particleEy,selected:a.current.selectedParticle};
  m.enabled=false;p(true);ie=requestAnimationFrame(fe);
};
`;
const replacements = [
  [oldBenchmark, instrumentation],
  [
    'let pe=()=>{document.hidden?de():le()};',
    "let pe=()=>{document.hidden?de('tab-hidden'):le()};",
  ],
  [
    'xe=e=>{e.preventDefault(),l(!0),de()};',
    "xe=e=>{e.preventDefault(),l(!0),de('context-lost')};",
  ],
  ['re=!0,de(),ue.disconnect()', "re=!0,de('disposed'),ue.disconnect()"],
];
let patched = original;
for (const [before, after] of replacements) {
  if (patched.split(before).length !== 2)
    throw new Error('Expected unique instrumentation anchor missing. No files copied.');
  patched = patched.replace(before, after);
}
patched =
  'import{createBenchmark as __pwCreate,orbitPoseAt as __pwOrbit,readWebGLInfo as __pwReadGL,createGpuTimer as __pwGpu}from"./render-benchmark-helper.js";\n' +
  patched;
async function inventory(directory, base = directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) files.push(...(await inventory(path, base)));
    else if (item.isFile())
      files.push({ path: relative(base, path), sha256: hash(await readFile(path)) });
    else throw new Error('Baseline must contain ordinary files/directories only.');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const sourceFiles = await inventory(source);
// Pin the entire production build as well as the renderer. Device probe pages may
// coexist beside the build; their hashes remain visible in the provenance inventory.
const expectedProduction = {
  'assets/PuckView-BwAkJHbz.js': expectedSha256,
  'assets/engine.worker-ZQBnSW_a.js':
    'fa3f01796ba803031536b06722bd10384f9a9b6e9cd29375bbc839b7a2ba5f0f',
  'assets/index-BjKcQLUE.css': 'd4bae328bd91a0c713805c2f7ee1f26807e82d31f195d91841ded80c7c9ffb99',
  'assets/index-C5j34d9z.js': '04ae8b78cbb5af7511880fa0f2d456597d59404d8b2d7f035ebd9e487c699df6',
  'assets/microstructure.worker-D5kHCbpK.js':
    '5804a9997ef5412e029346463c585e96ceb54508337dc45714b753cac926c4db',
  'assets/puckcore_bg-DJ7TOm5b.wasm':
    '73d831762ef0337ec0f5632fdc0a56caae7f893a038b3703a78cf8edf005ceec',
  'index.html': '8605c68e3cba69b8b41b44588ed8acb932ca24fc4d0b4407f8547c6ed9dbcf94',
  'favicon.svg': '8bf3a266239a17b40422b8284c997914c70c2aa6f4948e9df6a36e868410aeac',
  'third-party-licenses.md': '59b0876626da105caa4efaacba6245296ea2fb7da74efc1b9ac940f30808ec4d',
};
for (const [path, sha256] of Object.entries(expectedProduction))
  if (!sourceFiles.some((file) => file.path === path && file.sha256 === sha256))
    throw new Error(`Unknown baseline build file: ${path}. No files copied.`);
await cp(source, output, { recursive: true, force: false, errorOnExist: true });
await writeFile(join(output, asset), patched);
await writeFile(join(output, 'assets/render-benchmark-helper.js'), helper);
const provenance = {
  schema: 'puckworks.render-baseline-provenance/1',
  source,
  output,
  sourceFiles,
  originalAsset: { path: asset, sha256: expectedSha256 },
  instrumentedAssetSha256: hash(patched),
  helperSourceSha256: hash(helperSource),
  helperModuleSha256: hash(helper),
  normalizerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  protocol: {
    targetFps: { desktop: 60, viewportAtMost700Px: 30 },
    warmupMs: 1500,
    minWarmupFrames: 30,
    sampleMs: 5000,
    orbitRadiansPerSecond: 0.36,
    gpuQueryEveryFrames: 4,
  },
  changes: [
    'benchmark timing and result export',
    'fixed initial-pose wall-clock camera trajectory, reset at sample transition',
    'optional nonblocking GPU timer queries every fourth sampled submission',
  ],
  unchanged: [
    'renderer implementation',
    'shaders',
    'geometry',
    'particle count',
    'DPR policy',
    'physics and model',
  ],
  resultSelector: '.puck-view[data-render-benchmark]',
};
await writeFile(
  join(output, 'render-baseline-provenance.json'),
  JSON.stringify(provenance, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    output,
    sourceAssetSha256: expectedSha256,
    resultSelector: provenance.resultSelector,
  }),
);
