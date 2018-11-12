
/*
.start(time, beat)

Starts the sequencer from `beat` at `time`.
*/

/*
.stop(time)

Stops the sequencer `time`.
*/

/*
.cue(beat, fn)

Cues `fn` to be called on beat.
*/

/*
.beatAtTime(time)

Returns the beat at a given `time`.
*/

/*
.timeAtBeat(beat)

Returns the time at a given `beat`.
*/

import { each, get, id, insert, isDefined, Pool, toArray, by } from '../../fn/fn.js';
import { default as Sequence, log as logSequence } from './sequence.js';
import { getPrivates } from './utilities/privates.js';
import { createId } from './utilities/utilities.js';
import { isRateEvent, isMeterEvent, getDuration, getBeat } from './event.js';
import { automate, getValueAtTime } from './automate.js';
import Clock from './clock.js';
import Location, { locAtBeatEvents } from './location.js';
import Meter from './meter.js';
import { distribute } from './distribute.js';

const DEBUG = window.DEBUG;

const assign    = Object.assign;
const define    = Object.defineProperties;
const seedRateEvent  = { 0: 0, 1: 'rate' };
const seedMeterEvent = { 0: 0, 1: 'meter', 2: 4, 3: 1 };

function byBeat(a, b) {
	return a[0] === b[0] ? 0 :
		a[0] > b[0] ? 1 :
		-1 ;
}


const pool = [];

function Command(beat, type, event) {
	// If there is a command in the pool use that
	if (pool.length) {
		return Command.apply(pool.shift(), arguments);
	}

	this.beat  = beat;
	this.type  = type;
	this.event = event;
}

function processFrame(data, frame) {
	if (frame.type === 'stop') {
		// Todo: stop all events
		console.log('Implement stop frames');
		return data;
	}

	const events       = data.events;
	const buffer       = data.buffer;
	const commands     = data.commands;
	const stopCommands = data.stopCommands;
	const processed    = data.processed;
	const clock        = data.clock;
	const targets      = data.targets;
	const transport    = data.transport;

	// This assumes rateNode is already populated, or is
	// populated dynamically
	frame.b1 = clock.beatAtTime(frame.t1);
	frame.b2 = clock.beatAtTime(frame.t2);

	// Empty buffer
	buffer.length = 0;

	// Event index
	let n = -1;

	// Ignore events before b1
	while (++n < events.length && events[n][0] < frame.b1);
	--n;

	// Grab meter events up to b2
	// We do this first so that a generator might follow these changes
	let m = n;
	while (++m < events.length && events[m][0] < frame.b2) {
		// Schedule meter events on transport
		if (events[m][1] === 'meter') {
			transport.setMeterAtBeat(events[m][0] + transport.beatAtTime(clock.startTime), events[m][2], events[m][3]);
		}
	}

	// Grab events up to b2
	while (++n < events.length && events[n][0] < frame.b2) {
		let event = events[n];

		if (event[1] === 'meter' || event[1] === 'rate') {
			continue;
		}

		let eventType = event[1];
		let eventName = event[2];

		// Check that we are after the last buffered event of
		// this type and kind
		if (!processed[eventType]) {
			processed[eventType] = {};
			buffer.push(event);
			processed[eventType] = { [eventName]: event };
		}
		else if (!processed[eventType][eventName] || processed[eventType][eventName][0] < event[0]) {
			buffer.push(event);
			processed[eventType][eventName] = event;
		}
	}
	--n;

	// Grab exponential events beyond b2 that should be cued in this frame
	while (++n < events.length) {
		let event     = events[n];
		let eventType = event[1];
		let eventName = event[2];

		// Ignore non-param, non-exponential events
		if (event[1] !== "param" && event[4] !== "exponential") {
			continue;
		}

		// Check that we are after the last buffered event of
		// this type and kind, and that last event is before b2
		if (!processed[eventType]) {
			processed[eventType] = {};
			buffer.push(event);
			processed[eventType] = { [eventName]: event };
		}
		else if (!processed[eventType][eventName]) {
			buffer.push(event);
			processed[eventType][eventName] = event;
		}
		else if (processed[eventType][eventName][0] < frame.b2 && processed[eventType][eventName][0] < event[0]) {
			buffer.push(event);
			processed[eventType][eventName] = event;
		}
	}
	--n;

	// Populate commands
	commands.length = 0;

	// Populate commands from stopCommands buffer
	n = -1;
	while (++n < stopCommands.length) {
		if (stopCommands[n].beat < frame.b2) {
			stopCommands[n].time = clock.timeAtBeat(stopCommands[n].beat);
			commands.push(stopCommands[n]);
			stopCommands.splice(n, 1);
		}
	}

	// Populate commands from buffer
	n = -1;
	while (++n < buffer.length) {
		let event = buffer[n];
		let command = new Command(event[0], event[1], event);
		command.time = clock.timeAtBeat(command.beat);
		commands.push(command);

		// Deal with events that have duration
		let duration = getDuration(buffer[n]);
		if (duration !== undefined) {
			let stopCommand = new Command(event[0] + duration, event[1] + 'off', event);

			// Give stop and start a reference to each other
			stopCommand.startCommand = command;
			command.stopCommand = stopCommand;

			// If the stop is in this frame
			if (stopCommand[0] < frame.b2) {
				stopCommand.time = clock.timeAtBeat(stopCommand.beat);
				commands.push(stopCommand)
			}
			else {
				stopCommands.push(stopCommand);
			}
		}
	}

	return data;
}

function distributeData(data) {
	if (!data.commands.length) { return; }
	console.log('distributeData', data.commands.length + 's distributed.');

	const commands = data.commands;
	const targets  = data.targets;

	// Distribute commands
	let n = -1;
	while (++n < commands.length) {
		let command = commands[n];
		let target = command.startCommand ?
			targets.get(command.startCommand) :
			data.target ;

		let object = distribute(target, command.time, command.type, command.event[2], command.event[3]);

		if (command.stopCommand) {
			targets.set(command, object);
		}
		else {
			// Release back to pool
			if (command.startCommand) {
				pool.push(command.startCommand);
			}

			pool.push(command);
		}
	}
}

function assignTime(e0, e1) {
	e1.time = e0.time + locAtBeatEvents(e0, e1, e1[0] - e0[0]);
	return e1;
}

function automateRate(node, event) {
	console.log('automate rate', event);
	automate(node.offset, event.time, event[3] || 'step', event[2]) ;
	return node;
}


// Sequencer
//
// A singleton, Sequencer is a persistent, reusable wrapper for Cuestreams
// and RecordStreams, which are read-once. It is the `master` object from
// whence event streams sprout.

export default function Sequencer(context, rateNode, transport, distributors, sequences, events, timer) {

	// The base Clock provides the properties:
	//
	// startTime:      number || undefined
	// stopTime:       number || undefined

	Clock.call(this, context, transport);

	// Mix in Meter
	//
	// beatAtBar:  fn(n)
	// barAtBeat:  fn(n)
	//
	// There is no point in calling this as the constructor does nothing

	// Private

	const privates = getPrivates(this);
	privates.timer = timer;
	privates.rateNode = rateNode;
}

assign(Sequencer.prototype, Clock.prototype, Meter.prototype, {
	//create: function(generator, object) {
	//	var stream = this[$private].stream;
	//	return stream.create(generator, id, object);
	//},

	beatAtLocation: function(location) {
		const privates = getPrivates(this);
		// Sequencer is locked to rate of transport so no special rate
		// processing to bugger about with to work out location
		return privates.transport.beatAtTime(this.startTime + location)
			 - privates.transport.beatAtTime(this.startTime) ;
	},

	locationAtBeat: function(beat) {
		const privates = getPrivates(this);
		// Sequencer is locked to rate of transport so no special rate
		// processing to bugger about with to work out location.

		// Make sure rateNode automation is populated
		const rates = privates.rates;
		let event;


		// COOOEEEE!! this needs a rewrite!!

		while (rates[0] && rates[0][0] < beat) {
			event = rates.shift();
			// Doesnt work does it
			automate(rateNode, this.timeAtBeat(event[0]), event[3], event[2]);
		}

		if (rates[0] && rates[0][3] === 'exponential') {
			event = rates.shift();
			// Doesnt work does it
			automate(rateNode, this.timeAtBeat(event[0]), event[3], event[2]);
		}

		return privates.transport.locationAtBeat(
			privates.transport.beatAtTime(this.startTime) + beat
		) - (this.startTime - transport.startTime);
	},

	beatAtTime: function(time) {
		const privates = getPrivates(this);
		return privates.transport.beatAtTime(time)
			 - privates.transport.beatAtTime(this.startTime) ;
	},

	timeAtBeat: function(beat) {
		const privates = getPrivates(this);
		return privates.transport.timeAtBeat(
			privates.transport.beatAtTime(this.startTime) + beat
		);
	},

	start: function(time, beat) {
		time = time || this.context.currentTime;

		const sequencer = this;
		const privates  = getPrivates(this);
		const stream    = privates.stream;
		const events    = this.events;
		const rateNode  = privates.rateNode;

		// If stream is not waiting, stop it and start a new one
		if (stream) {
			stream.stop(time);
		}

		// Set this.startTime
		Clock.prototype.start.call(this, time, beat);

		// Run transport, if it is not already
		privates.transport.start(time, beat);

		// Set rates
		const rates = this.events ?
			this.events.filter(isRateEvent).sort(byBeat) :
			nothing ;

		seedRateEvent.time = time;
		seedRateEvent[2]   = getValueAtTime(rateNode, time);
		rates.reduce(assignTime, seedRateEvent);
		rates.reduce(automateRate, rateNode);

		// Stream events
		const data = {
			clock:    this,
			transport: privates.transport,
			events:   this.events,
			buffer:   [],
			commands: [],
			stopCommands: [],
			processed: {},
			// Where target come from?
			target:   undefined,
			targets:  new Map()
		};

		privates.stream = Stream
		.fromTimer(privates.timer)
		.fold(processFrame, data)
		.each(distributeData)
		.start(time);

		return this;
	},

	stop: function(time) {
		time = time || this.context.currentTime;

		const privates = getPrivates(this);
		const stream   = privates.stream;
		const rateNode = privates.rateNode;

		//console.log('Soundstage stop() ', time, status);

		privates.beat = this.beatAtTime(time);
		stream.stop(time);
		privates.transport.stop(time);

		// Set rates
		//automate(rateNode, time, 'step', getValueAtTime(rateNode, time));

		// Log the state of Pool shortly after stop
		//if (DEBUG) {
		//	setTimeout(function() {
		//		logSequence(sequencer);
		//		console.log('Pool –––––––––––––––––––––––––––––––––');
		//		console.table(Pool.snapshot());
		//	}, 400);
		//}

		return this;
	},

	sequence: function(toEventsBuffer) {
		const privates = getPrivates(this);
		const transport = privates.transport;
		return transport.sequence(toEventsBuffer);
	},

	cue: function(beat, fn) {
		var stream = getPrivates(this).stream;
		stream.cue(beat, fn);
		return this;
	}
});
