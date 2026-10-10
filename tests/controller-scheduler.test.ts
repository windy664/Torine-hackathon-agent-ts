import assert from 'node:assert/strict';
import test from 'node:test';
import { prioritizeEvolution, type ScheduledModule } from '../controller-scheduler.js';
const atom = (id: string, change = false, dependencies: string[] = []) => ({ id, type: 'ATOMIC', description: change ? 'Modified Feature Description\nPreserve and change behavior.' : 'Existing behavior', dependencies, scenarios: [] });
const module = (id: string, children: any[]): ScheduledModule => ({ index: 1, total: 1, nodeId: id, name: id, rootContext: 'ROOT contract', moduleContext: 'Module contract', subtree: { id, type: 'FOLDER', description: 'Keep ancestor contract', children } });
const ids = (modules: ScheduledModule[]) => {
 const out: string[] = []; const walk = (n: any) => { if (n.type === 'ATOMIC') out.push(n.id); (n.children ?? []).forEach(walk); };
 modules.forEach(m => walk(m.subtree)); return out;
};
test('changes and dependencies precede untouched work without dropping or mutating any atomic', () => {
 const input = [module('M1', [atom('old'), atom('base')]), module('M2', [atom('unrelated'), atom('changed', true, ['base','external'])])];
 const before = JSON.stringify(input); const result = prioritizeEvolution(input);
 assert.deepEqual(ids(result), ['base','changed','old','unrelated']);
 assert.equal(JSON.stringify(input), before); assert.equal(result[1].subtree.description, 'Keep ancestor contract');
 assert.deepEqual(result[1].subtree.children[0].dependencies, ['base','external']);
});
test('dependencies within a shared parent reorder the actual pruned tree', () => {
 const result = prioritizeEvolution([module('M', [atom('dependent', true, ['prerequisite']), atom('prerequisite')])]);
 assert.deepEqual(ids(result), ['prerequisite','dependent']);
});
test('ROOT-level atomics work as separate modules and retain all work', () => {
 const input = [atom('A'),atom('B',true)].map((subtree,index) => ({...module(subtree.id,[]),subtree,index:index+1,total:2}));
 assert.deepEqual(ids(prioritizeEvolution(input)), ['B','A']);
});
test('large atomics remain whole, groups are bounded, and unmarked input keeps its original shape', () => {
 const plain = [module('M', [atom('A'),atom('B')])]; assert.equal(prioritizeEvolution(plain), plain);
 const huge = {...atom('large',true),description:'Modified Feature Description\n'+'x'.repeat(21000)};
 const result = prioritizeEvolution([module('M',[huge,...Array.from({length:7},(_,i)=>atom(`N${i}`,true))])]);
 assert.equal(result.length,3); assert.equal(result[0].subtree.children[0].description,huge.description);
 assert.equal(ids(result).length,8);
});
test('cyclic explicit dependencies are surfaced to the caller fallback', () => {
 assert.throws(()=>prioritizeEvolution([module('M',[atom('A',true,['B']),atom('B',false,['A'])])]),/cycle/);
});
test('ancestor dependency labels do not create artificial cycles', () => {
 assert.deepEqual(ids(prioritizeEvolution([module('M',[atom('A',true,['M','ROOT']),atom('B',false,['M'])])])),['A','B']);
});
