// JXA adapter for SwitchAudioSource. The core functions are also exported for
// fixture tests; macOS-only command execution stays below `run`.

if (typeof ObjC !== "undefined") {
    ObjC.import("Foundation");
}

function recordError(message) {
    var error = new Error(message);
    error.name = "AudioDeviceError";
    return error;
}

function parseDeviceRecord(line, expectedType) {
    var record = String(line).replace(/[\r\n]+$/, "");
    // Current and older SwitchAudioSource builds both use comma-delimited
    // records, but some omit the UID or add whitespace around delimiters.
    var match = record.match(/^(.*),\s*(input|output|system)\s*,\s*([0-9]+)(?:\s*,\s*(.*))?$/);
    if (!match || !match[1] || (expectedType && match[2] !== expectedType)) {
        throw recordError("Unexpected record: " + record.slice(0, 160));
    }

    return {
        name: match[1].replace(/\s+$/, ""),
        type: match[2],
        id: match[3],
        uid: match[4] || ""
    };
}

function parseDeviceRecords(output, expectedType) {
    // JXA's doShellScript normalizes command output to CR line endings.
    var lines = String(output).split(/\r\n|\r|\n/);
    var devices = [];
    var i;
    for (i = 0; i < lines.length; i += 1) {
        if (lines[i].replace(/\r$/, "") === "") {
            continue;
        }
        devices.push(parseDeviceRecord(lines[i], expectedType));
    }
    return devices;
}

function invalidItem(title, subtitle) {
    return {
        title: title,
        subtitle: subtitle,
        valid: false,
        autocomplete: ""
    };
}

function resultError(kind, detail, commandError) {
    var messages = {
        missing: ["SwitchAudioSource is not installed", "Run: brew install switchaudio-osx"],
        command: ["SwitchAudioSource could not read audio devices", commandError || "Check the workflow debugger and try again."],
        malformed: ["SwitchAudioSource returned unreadable device data", commandError || "Update switchaudio-osx, then try again."],
        empty: ["No connected " + detail + " devices found", "Connect a device, then try again."],
        current: ["Could not determine the current " + detail + " device", commandError || "Check SwitchAudioSource and try again."]
    };
    var message = messages[kind] || messages.command;
    return { items: [invalidItem(message[0], message[1])] };
}

function deviceItems(direction, devices, currentID) {
    var counts = {};
    var i;
    for (i = 0; i < devices.length; i += 1) {
        counts[devices[i].name] = (counts[devices[i].name] || 0) + 1;
    }

    var items = [];
    for (i = 0; i < devices.length; i += 1) {
        var device = devices[i];
        var current = device.id === String(currentID);
        var duplicateSuffix = counts[device.name] > 1 ? " — Device " + device.id : "";
        items.push({
            uid: "audio-" + direction + "-" + (device.uid || "id-" + device.id),
            title: device.name,
            subtitle: (current ? "Current " : "") + direction + " device" + duplicateSuffix,
            arg: device.id,
            variables: { audio_device_id: device.id },
            icon: { path: direction + ".png" },
            match: device.name + " " + device.uid,
            autocomplete: device.name
        });
    }
    return { items: items };
}

function listResult(direction, listRun, currentRun) {
    if (!listRun || listRun.missing) {
        return resultError("missing", direction);
    }
    if (listRun.error || listRun.status !== 0) {
        return resultError("command", direction, listRun.stderr);
    }

    var devices;
    try {
        devices = parseDeviceRecords(listRun.stdout, direction);
    } catch (error) {
        return resultError("malformed", direction, error.message);
    }
    if (!devices.length) {
        return resultError("empty", direction);
    }
    if (!currentRun || currentRun.error || currentRun.status !== 0) {
        return resultError("current", direction, currentRun && currentRun.stderr);
    }

    try {
        return deviceItems(direction, devices, parseDeviceRecord(currentRun.stdout, direction).id);
    } catch (error) {
        return resultError("current", direction);
    }
}

function notificationResult(message) {
    return JSON.stringify({ alfredworkflow: { variables: { audio_notification: message } } });
}

function switchNotification(direction, device, observed) {
    var target = String(device.id);
    if (direction === "input") {
        if (observed.input === target) {
            return "Input changed to “" + device.name + "”.";
        }
        return "Input switch failed: default input is " + (observed.input || "unreadable") + ".";
    }

    var media = observed.output === target;
    var system = observed.system === target;
    if (media && system) {
        return "Output and system alerts changed to “" + device.name + "”.";
    }
    if (media) {
        return "Output changed to “" + device.name + "”, but system alerts remain on " + (observed.system || "an unreadable device") + ".";
    }
    if (system) {
        return "System alerts changed to “" + device.name + "”, but media output remains on " + (observed.output || "an unreadable device") + ".";
    }
    if (observed.output && observed.system && observed.output !== observed.system) {
        return "Output switch failed: media output is " + observed.output + " and system alerts are " + observed.system + ".";
    }
    return "Output switch failed: media output and system alerts did not change to “" + device.name + "”.";
}

function switchError(message) {
    return notificationResult(message);
}

function executablePath() {
    var candidates = ["/opt/homebrew/bin/SwitchAudioSource", "/usr/local/bin/SwitchAudioSource"];
    var manager = $.NSFileManager.defaultManager;
    var i;
    for (i = 0; i < candidates.length; i += 1) {
        if (manager.fileExistsAtPath($(candidates[i]))) {
            return candidates[i];
        }
    }
    return null;
}

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function runCommand(executable, args) {
    // `doShellScript` is the stable JXA process boundary. NSTask values are
    // bridged inconsistently across macOS releases when Alfred runs JXA.
    var app = Application.currentApplication();
    app.includeStandardAdditions = true;
    var command = [executable].concat(args).map(shellQuote).join(" ");
    try {
        return { status: 0, stdout: app.doShellScript(command), stderr: "" };
    } catch (error) {
        return { status: 1, stdout: "", stderr: String(error), error: true };
    }
}

function listCommand(executable, direction) {
    return runCommand(executable, ["-a", "-t", direction, "-f", "cli"]);
}

function currentCommand(executable, direction) {
    return runCommand(executable, ["-c", "-t", direction, "-f", "cli"]);
}

function listDevices(direction) {
    var executable = executablePath();
    if (!executable) {
        return JSON.stringify(listResult(direction, { missing: true }, null));
    }
    return JSON.stringify(listResult(direction, listCommand(executable, direction), currentCommand(executable, direction)));
}

function selectedDevice(executable, direction, deviceID) {
    var list = listCommand(executable, direction);
    var devices;
    if (list.error || list.status !== 0) {
        return null;
    }
    try {
        devices = parseDeviceRecords(list.stdout, direction);
    } catch (error) {
        return null;
    }
    var i;
    for (i = 0; i < devices.length; i += 1) {
        if (devices[i].id === deviceID) {
            return devices[i];
        }
    }
    return null;
}

function switchDevice(direction, deviceID) {
    if (!/^[0-9]+$/.test(String(deviceID))) {
        return switchError("Audio switch failed: invalid device selection.");
    }
    var executable = executablePath();
    if (!executable) {
        return switchError("SwitchAudioSource is not installed. Run: brew install switchaudio-osx");
    }

    var device = selectedDevice(executable, direction, String(deviceID));
    if (!device) {
        return switchError("Audio switch failed: the selected device is no longer available.");
    }

    runCommand(executable, ["-t", direction, "-i", device.id]);
    if (direction === "input") {
        var input = currentCommand(executable, "input");
        var inputID = null;
        try {
            inputID = !input.error && input.status === 0 ? parseDeviceRecord(input.stdout, "input").id : null;
        } catch (error) {}
        return switchError(switchNotification("input", device, { input: inputID }));
    }

    runCommand(executable, ["-t", "system", "-i", device.id]);
    var output = currentCommand(executable, "output");
    var system = currentCommand(executable, "system");
    var outputID = null;
    var systemID = null;
    try {
        outputID = !output.error && output.status === 0 ? parseDeviceRecord(output.stdout, "output").id : null;
    } catch (error) {}
    try {
        systemID = !system.error && system.status === 0 ? parseDeviceRecord(system.stdout, "system").id : null;
    } catch (error) {}
    return switchError(switchNotification("output", device, { output: outputID, system: systemID }));
}

function run(argv) {
    var action = argv[0];
    var direction = argv[1];
    try {
        if ((direction !== "input" && direction !== "output") || (action !== "list" && action !== "switch")) {
            throw recordError("Expected: list|switch input|output [device-id]");
        }
        return action === "list" ? listDevices(direction) : switchDevice(direction, argv[2]);
    } catch (error) {
        return action === "list"
            ? JSON.stringify(resultError("command", direction || "audio"))
            : switchError("Audio switch failed: " + error.message);
    }
}

if (typeof module !== "undefined") {
    module.exports = {
        parseDeviceRecord: parseDeviceRecord,
        parseDeviceRecords: parseDeviceRecords,
        listResult: listResult,
        deviceItems: deviceItems,
        resultError: resultError,
        shellQuote: shellQuote,
        switchNotification: switchNotification,
        notificationResult: notificationResult
    };
}
