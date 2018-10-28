
import { compose, get, is, isDefined, map, nothing }   from '../../fn/fn.js';
import AudioObject            from '../../audio-object/modules/audio-object.js';
import requestInputSplitter   from '../../audio-object/modules/request-input-splitter.js';

import { print, printGroup, printGroupEnd }     from './utilities/print.js';
import { getPrivates } from './utilities/privates.js';
import { distributeEvent } from './distribute.js';
import audio         from './context.js';
import constructors  from './constructors';
import { connect, disconnect } from './connect.js';
import Backstage     from './backstage.js';
import Input         from './nodes/input.js';
import Output        from './nodes/output.js';
import Graph         from './graph.js';
import requestPlugin from './request-plugin.js';
import Controls      from './controls.js';
import Transport     from './transport.js';
import Sequence      from './sequence.js';
import Sequencer     from './sequencer.js';
import config        from './config.js';

const assign       = Object.assign;
const define       = Object.defineProperties;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const setPrototypeOf = Object.setPrototypeOf;


function isURL() {
    return false;
}

// Soundstage

function createOutputMerger(context, target) {
    // Safari sets audio.destination.maxChannelCount to
    // 0 - possibly something to do with not yet
    // supporting multichannel audio, but still annoying.
    var count = target.maxChannelCount > config.channelCountLimit ?
        config.channelCountLimit :
        target.maxChannelCount ;

    var merger = new ChannelMergerNode(context, {
        numberOfInputs: count
    });

    // Used by meter-canvas controller - there is no way to automatically
    // determine the number of channels in a signal.
    //
    // Huh? What about numberOfInputs?
    merger.outputChannelCount = count;

    // Make sure incoming connections do not change the number of
    // output channels (number of output channels is determined by
    // the sum of channels from all inputs).
    merger.channelCountMode = 'explicit';

    // Upmix/downmix incoming connections.
    merger.channelInterpretation = 'discrete';

    merger.connect(target);
    return merger;
}

function requestAudioNode(context, settings, backstage) {
    const Node = constructors[settings.type];
    return Node ?
        Promise.resolve(new Node(context, settings.data, backstage)) :
        requestPlugin(settings.type).then(function(Constructor) {
            return new Constructor(context, settings.data, backstage);
        });
}

export default function Soundstage(data, settings) {
    if (!Soundstage.prototype.isPrototypeOf(this)) {
        // Soundstage has been called without the new keyword
        return new Soundstage(data, settings);
    }

    data     = data || nothing;
    settings = settings || nothing;

    if (isDefined(data.version) && data.version !== this.version) {
        throw new Error('Soundstage: data version mismatch.', this.version, data.version);
    }


    if (DEBUG) { printGroup('Soundstage()'); }

    // Initialise soundstage as an Audio Object with no inputs and
    // a channel merger as an output. Assigns:
    //
    // audio:      audio context

    const stage       = this;
    const context     = settings.context || audio;
    const destination = settings.output || context.destination;
    const output      = createOutputMerger(context, destination);

    //Soundstage.inspector && Soundstage.inspector.drawAudioFromNode(output);


    // Initialise audio regions. Assigns:
    //
    // regions:    array

    const regions
        = this.regions
        = (settings.regions || []).map(function(data) {
            return Region(context, data);
        });


    // Initialise soundstage as a graph. Assigns:
    //
    // nodes:       array
    // connections: array

    const requestTypes = {
        input: function(context, data) {
            return requestInputSplitter(context).then(function(input) {
                return new Input(context, data.object, input);
            });
        },

        output: function(context, data) {
            return Promise.resolve(new Output(context, data.object, output));
        },

        default: requestAudioNode
    };

    const backstage = new Backstage(this);

    Graph.call(this, context, requestTypes, data, backstage);


    // Initialise MIDI and keyboard controls. Assigns:
    //
    // controls:   array-like

    this.ready(function graphReady(stage) {
        define(stage, {
            controls: {
                enumerable: true,
                value: new Controls(function getTarget(id) {
                    return stage.get(id);
                }, data.controls)
            }
        });
    });


    // Initialise soundstage as a Sequence. Assigns:
    //
    // name:       string
    // sequences:  array
    // events:     array

    Sequence.call(this, data);


    // Initialise soundstage as a Sequencer. Assigns:
    //
    // start:      fn
    // stop:       fn
    // beatAtTime: fn
    // timeAtBeat: fn
    // beatAtLocation: fn
    // locationAtBeat: fn
    // beatAtBar:  fn
    // barAtBeat:  fn
    // cue:        fn
    // status:     string

    const distributors = {
        "sequence": function(object, event, stream, transform) {
            const type = typeof event[2];

            // Find the sequence
            const sequence = type === 'string' ?
                    isURL(event[2]) ? fetchSequence(event[2]) :
                stage.sequences.find(compose(is(event[2]), get('id'))) :
            event[2] ;

            if (!sequence) {
                console.warn('Soundstage: sequence not found', event);
                return;
            }

            // Get sequence events
            const events = sequence.events;
            if (!events || !events.length) {
                console.warn('Soundstage: sequence has no events', event);
                return;
            }

            // Get the target object
            if (isDefined(event[3])) {
                const node = stage.get(event[3]);
                object = node && node.object;
            }

            // If there is none, warn
            if (!object) {
                console.warn('Soundstage: object not found', event);
                return;
            }

            return stream
            .create(events, transform, object)
            .start(event[0]);
        },

        "meter": function(object, event) {

        },

        'default': distributeEvent
    };

    Sequencer.call(this, context, distributors, this.sequences, this.events);

    /*
    // Initialise as a recorder...

    var recordStream   = RecordStream(this, this.sequences);
    */


    // Create metronome.
    //this.metronome = new Metronome(context, data.metronome, this);
    //this.metronome.start(0);


    // Define variables

    define(this, {
        context:           { value: context },
        mediaChannelCount: { value: undefined, writable: true, configurable: true },
        roundTripLatency:  { value: Soundstage.roundTripLatency, writable: true, configurable: true },
    });


    /*
    // Setup from data and notify when all components are loaded and ready

    const loaded = this
    .update(data)
    .then(function(stage) {
        console.log('Soundstage: ready');
    });

    this.ready = loaded.then.bind(loaded);
    */

    if (DEBUG) { printGroupEnd(); }
}

define(Soundstage.prototype, {
    version: { value: 1 },
    beat:    getOwnPropertyDescriptor(Transport.prototype, 'beat'),
    status:  getOwnPropertyDescriptor(Transport.prototype, 'status')
});

/*
.timeAtDomTime(domTime)

Returns audio context time at a given DOM time, where `domTime` is a time in
seconds relative to window.performance.now().
*/

assign(Soundstage.prototype, Sequencer.prototype, Graph.prototype, {
    timeAtDomTime: function(domTime) {
        return timeAtDomTime(this.context, domTime);
    },

    domTimeAtTime: function(domTime) {
        return domTimeAtTime(this.context, domTime);
    },

    destroy: function() {
        // Destroy the playhead.
        //Head.prototype.destroy.call(this);

        // Remove soundstage's input node from mediaInputs, and disconnect
        // media from it.
        var input = AudioObject.getInput(this);
        var i     = mediaInputs.indexOf(input);

        if (i > -1) {
            mediaInputs.splice(i, 1);
        }

        requestMedia(this.audio)
        .then(function(media) {
            media.disconnect(input);
        });

        var output = AudioObject.getOutput(this);
        output.disconnect();

        this[$store].modify('clear');
        return this;
    }
});
