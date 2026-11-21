import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMelodyPreserved } from '../src/music/melody-contract.js';

const notes = [
  { midi: 69, start: 0.27, duration: 0.08, contour: [{ time: 0, frequency: 435 }, { time: 0.06, frequency: 444 }] },
  { midi: 69, start: 0.39, duration: 0.12 },
  { midi: 67, start: 0.61, duration: 0.19 },
];
const arrangement = () => ({ events: [...structuredClone(notes).map(note => ({ ...note, track: 'melody' })), { midi: 48, start: 0, duration: 0.8, track: 'bass' }] });

test('preservation proof checks the full lead while allowing additional backing', () => {
  assert.deepEqual(assertMelodyPreserved(notes, arrangement()), {
    engine: 'strict-note-conditioned', preserved: true, timingPreserved: true,
    noteCount: 3, contourPointCount: 2, timingScale: 1, toleranceSeconds: 0.000001,
  });
});

test('preservation contract rejects omitted, invented, reordered and repitched lead notes', () => {
  for (const mutate of [
    events => events.splice(1, 1),
    events => events.push({ midi: 60, start: 0.8, duration: 0.1, track: 'melody' }),
    events => { [events[0], events[1]] = [events[1], events[0]]; },
    events => { events[0].midi = 70; },
  ]) {
    const result = arrangement();
    mutate(result.events);
    assert.throws(() => assertMelodyPreserved(notes, result), /melody.*(count|order|pitch|start|timing|note)/i);
  }
});

test('preservation contract rejects retimed gates and altered or removed pitch contours', () => {
  for (const mutate of [
    event => { event.start += 0.002; },
    event => { event.duration += 0.002; },
    event => { event.contour[0].time = 0.001; },
    event => { event.contour[0].frequency = 440; },
    event => { delete event.contour; },
    event => { event.contour.push({ time: 0.07, frequency: 445 }); },
  ]) {
    const result = arrangement();
    mutate(result.events[0]);
    assert.throws(() => assertMelodyPreserved(notes, result), /melody.*(start|duration|timing|contour)/i);
  }
});

test('contract permits only numerical rounding tolerance and an explicit timing scale', () => {
  const rounded = arrangement();
  rounded.events[0].start += 0.0000005;
  assert.equal(assertMelodyPreserved(notes, rounded).preserved, true);
  const transformed = arrangement();
  for (const event of transformed.events.filter(event => event.track === 'melody')) {
    event.start *= 0.5; event.duration *= 0.5;
    event.contour?.forEach(point => { point.time *= 0.5; });
  }
  assert.throws(() => assertMelodyPreserved(notes, transformed), /melody/i);
  assert.equal(assertMelodyPreserved(notes, transformed, { timingScale: 0.5 }).timingPreserved, false);
});

test('invalid source and missing melody cannot earn a preservation proof', () => {
  assert.throws(() => assertMelodyPreserved([], { events: [] }), /melody|notes/i);
  assert.throws(() => assertMelodyPreserved([notes[0], { midi: NaN, start: 0.4, duration: 0.1 }], arrangement()), /note|melody/i);
  assert.throws(() => assertMelodyPreserved(notes, { events: arrangement().events.filter(event => event.track !== 'melody') }), /melody/i);
});
