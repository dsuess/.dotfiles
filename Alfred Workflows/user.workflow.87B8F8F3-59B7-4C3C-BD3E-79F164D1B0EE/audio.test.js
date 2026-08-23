#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const audio = require('./audio.js');

function run(stdout, status = 0) {
  return { stdout, status };
}

function titles(result) {
  return result.items.map((item) => item.title);
}

const records = audio.parseDeviceRecords(
  'MacBook Microphone,input,12,BuiltInMicrophoneDevice\r\n' +
  'Desk, “quoted”,input,24,USB,123\n',
  'input'
);
assert.deepStrictEqual(records, [
  { name: 'MacBook Microphone', type: 'input', id: '12', uid: 'BuiltInMicrophoneDevice' },
  { name: 'Desk, “quoted”', type: 'input', id: '24', uid: 'USB,123' }
]);
assert.deepStrictEqual(
  audio.parseDeviceRecords('soundcore  Q30,output,85,88-0E-85-CC-FE-3E:output\rMacBook Pro Speakers,output,73,BuiltInSpeakerDevice', 'output').map((device) => device.id),
  ['85', '73']
);
assert.throws(() => audio.parseDeviceRecords('not a record\n', 'input'), /Unexpected/);
assert.throws(() => audio.parseDeviceRecords('Mic,output,12,uid\n', 'input'), /Unexpected/);
assert.deepStrictEqual(audio.parseDeviceRecord('USB Mic, input, 42', 'input'), {
  name: 'USB Mic', type: 'input', id: '42', uid: ''
});
assert.deepStrictEqual(audio.parseDeviceRecord('Desk Mic, output , 43 , uid-43', 'output'), {
  name: 'Desk Mic', type: 'output', id: '43', uid: 'uid-43'
});

const list = audio.listResult(
  'output',
  run('Desk, “quoted”,output,12,uid-a\nDesk, “quoted”,output,24,uid-b\n'),
  run('Desk, “quoted”,output,24,uid-b\n')
);
assert.strictEqual(list.items.length, 2);
assert.deepStrictEqual(titles(list), ['Desk, “quoted”', 'Desk, “quoted”']);
assert.strictEqual(list.items[0].uid, 'audio-output-uid-a');
assert.strictEqual(list.items[1].uid, 'audio-output-uid-b');
assert.strictEqual(list.items[1].arg, '24');
assert.strictEqual(list.items[1].variables.audio_device_id, '24');
assert.deepStrictEqual(list.items[1].icon, { path: 'output.png' });
assert.match(list.items[0].subtitle, /Device 12/);
assert.match(list.items[1].subtitle, /Current output device/);
assert.match(list.items[1].match, /uid-b/);
assert.strictEqual(list.items[1].autocomplete, 'Desk, “quoted”');
assert.deepStrictEqual(JSON.parse(JSON.stringify(list)).items.map((item) => item.title), ['Desk, “quoted”', 'Desk, “quoted”']);

const uidFallback = audio.deviceItems('input', [{ name: 'No UID', type: 'input', id: '99', uid: '' }], '0');
assert.strictEqual(uidFallback.items[0].uid, 'audio-input-id-99');

assert.match(audio.listResult('input', { missing: true }, null).items[0].title, /not installed/);
const commandFailure = audio.listResult('input', { stdout: '', status: 1, stderr: 'permission denied' }, null);
assert.match(commandFailure.items[0].title, /could not read/);
assert.strictEqual(commandFailure.items[0].subtitle, 'permission denied');
assert.strictEqual(audio.shellQuote("one's device"), "'one'\"'\"'s device'");
const malformed = audio.listResult('input', run('bad\n'), null);
assert.match(malformed.items[0].title, /unreadable/);
assert.match(malformed.items[0].subtitle, /Unexpected record: bad/);
assert.match(audio.listResult('input', run(''), run('Mic,input,1,uid\n')).items[0].title, /No connected input/);
assert.match(audio.listResult('input', run('Mic,input,1,uid\n'), run('bad\n')).items[0].title, /Could not determine/);

const target = { name: 'Desk, “quoted”', id: '24', uid: 'uid-b' };
assert.strictEqual(audio.switchNotification('input', target, { input: '24' }), 'Input changed to “Desk, “quoted””.');
assert.match(audio.switchNotification('input', target, { input: '12' }), /Input switch failed/);
assert.strictEqual(
  audio.switchNotification('output', target, { output: '24', system: '24' }),
  'Output and system alerts changed to “Desk, “quoted””.'
);
assert.match(audio.switchNotification('output', target, { output: '24', system: '12' }), /but system alerts remain/);
assert.match(audio.switchNotification('output', target, { output: '12', system: '24' }), /but media output remains/);
assert.match(audio.switchNotification('output', target, { output: '12', system: '13' }), /media output is 12 and system alerts are 13/);
assert.match(audio.switchNotification('output', target, { output: null, system: null }), /did not change/);

const notification = JSON.parse(audio.notificationResult('Selected device vanished.'));
assert.strictEqual(notification.alfredworkflow.variables.audio_notification, 'Selected device vanished.');

const plist = fs.readFileSync(path.join(__dirname, 'info.plist'), 'utf8');
assert.match(plist, /audio\.js" switch input "\$1"/);
assert.match(plist, /audio\.js" switch output "\$1"/);
assert.doesNotMatch(plist, /\{var:audio_device_id\}/);
assert.strictEqual(
  (plist.match(/<key>scriptargtype<\/key>\s*<integer>1<\/integer>/g) || []).length,
  2
);

console.log('audio-device-switcher fixtures: ok');
