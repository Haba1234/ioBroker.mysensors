/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

// you have to require the utils module and call adapter function
var utils      = require(__dirname + '/lib/utils'); // Get common adapter utils
var serialport;
var Parses     = require('sensors');
var MySensors  = require(__dirname + '/lib/mysensors');
var getMeta    = require(__dirname + '/lib/getmeta').getMetaInfo;
var getMeta2   = require(__dirname + '/lib/getmeta').getMetaInfo2;

var adapter   = new utils.Adapter('mysensors');
var devices   = {};
var mySensorsInterface;
var floatRegEx = /^[+-]?\d+(\.\d*)$/;
var inclusionOn = false;
var inclusionTimeout = false;
var path;
var fs;
var config = {};
const FIRMWARE_BLOCK_SIZE = 16;

try {
    serialport = require('serialport');//.SerialPort;
} catch (e) {
    console.warn('Serial port is not available');
}

function filterSerialPorts(path) {
    // get only serial port names
    if (!(/(tty(S|ACM|USB|AMA|MFD)|rfcomm)/).test(path)) return false;

    return fs
        .statSync(path)
        .isCharacterDevice();
}

function listSerial(ports) {
    ports = ports || [];
    path  = path || require('path');
    fs    = fs   || require('fs');

    // Filter out the devices that aren't serial ports
    var devDirName = '/dev';

    var result;
    try {
        result = fs
            .readdirSync(devDirName)
            .map(function (file) {
                return path.join(devDirName, file);
            })
            .filter(filterSerialPorts)
            .map(function (port) {
                var found = false;
                for (var v = 0; v < ports.length; v++) {
                    if (ports[v].comName === port) {
                        found = true;
                        break;
                    }
                }
                if (!found) ports.push({comName: port});
                return {comName: port};
            });
    } catch (e) {
        if (require('os').platform() !== 'win32') {
            adapter.log.error('Cannot read "' + devDirName + '": ' + e);
        }
        result = [];
    }
    return result;
}

function getNodesList(obj){
	let nodesList = [];
	let nodesList2 = [];
	let objListNodes = {};
	adapter.getDevicesAsync()
        .then(arrDevices => {
			let chain = [];
            arrDevices.forEach(obj => {
				nodesList2.push([obj._id.split('.')[2], obj.common.name]);
				//adapter.log.warn('obj: ' + JSON.stringify(obj));
				chain.push(new Promise((resolve, reject) => {
					adapter.getChannelsOf(obj._id, function (err, channels){
						//adapter.log.warn('channels1: ' + JSON.stringify(channels));
						var listChannels = [];
						channels.forEach(channel => {
							if (channel._id.indexOf('255_ARDUINO_NODE') > 0){
								nodesList.push([obj._id.split('.')[2], obj.common.name, channel.common.name]);
								listChannels.push(channel._id);
							}
						});
						resolve(listChannels);
					});
				}));
			});						
			return Promise.all(chain)
		})
		.then (listChannels => {
			//adapter.log.warn('listChannels: ' + JSON.stringify(listChannels));
			//adapter.log.warn('nodesList: ' + JSON.stringify(nodesList));
			let chain = [];
			listChannels.forEach(channel => {
				if (channel.length) {
					//adapter.log.warn('channel: ' + channel);
					chain.push(new Promise((resolve, reject) => {
						resolve(adapter.getStateAsync(`${channel}.I_SKETCH_VERSION`));
					}));
				}
			});
			return Promise.all(chain);
		})
		.then (sketchVer => {
			let tmpListNodes = sketchVer.map(({ val }) => val).map((node, i) => {
				nodesList[i][1] = nodesList[i][1] + ' (ver. ' + node + ')';
				return nodesList[i];
			});
			//adapter.log.warn('tmpListNodes: ' + JSON.stringify(tmpListNodes));
			tmpListNodes.forEach((node, i) => {
				//adapter.log.warn('tmpListNodes: ' + JSON.stringify(node));
				nodesList2.findIndex((node2, index)=>{
					if (node[0] === node2[0]) {
						nodesList2[index][1] = node[1];
						nodesList2[index].push(node[2]);
						objListNodes[node2[0]] = nodesList2[index];
						return true;
					}
					objListNodes[node2[0]] = nodesList2[index];
					return false;
				});
			});
			//adapter.log.warn('nodesList2: ' + JSON.stringify(nodesList2));
			adapter.log.warn('objListNodes: ' + JSON.stringify(objListNodes));
			try {
				adapter.sendTo(obj.from, obj.command, objListNodes, obj.callback);
			}
			catch (e) {
			   // инструкции для работы с ошибками
			   adapter.log.error(e); // передает объект ошибки для управления им
			}
		})
		.catch(err => {
            adapter.log.error('nodesList error: ' + JSON.stringify(err));
        });
}

//принимаем и обрабатываем сообщения
adapter.on('message', function (obj) {
    if (obj) {
		adapter.log.warn('obj.command: ' + obj.command);
		let id;
        switch (obj.command.split('.')[0]) {
            case 'listUart':
                if (obj.callback) {
                    if (serialport) {
                        // read all found serial ports
                        serialport.list(function (err, ports) {
                            adapter.log.info('List of port: ' + JSON.stringify(ports));
                            listSerial(ports);
                            adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                        });
                    } else {
                        adapter.log.warn('Module serialport is not available');
                        adapter.sendTo(obj.from, obj.command, [{comName: 'Not available'}], obj.callback);
                    }
                }
                break;
			case 'getNodes':
				getNodesList(obj);
				break;
			case 'rebootID':
				id = obj.command.split('.')[1];
				adapter.log.debug('Rebooting node ID = ' + id);
				mySensorsInterface.write(id + ';255;3;1;13;1');
				break;
			case 'downloadID':
				let filename = obj.command.split(' ')[1];
				id = obj.command.split(' ')[0].split('.')[1];
				adapter.log.debug('Download frimware node ID = ' + id);
				adapter.log.debug(filename);
				loadFirmware(filename);
				break;
        }
    }
});

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    adapter.setState('info.connection', false, true);
    try {
        if (mySensorsInterface) mySensorsInterface.destroy();
        mySensorsInterface = null;
        callback();
    } catch (e) {
        callback();
    }
});

function crcUpdate(old, value) {
	let c = old ^ value;
	for (let i = 0; i < 8; ++i) {
		if ((c & 1) > 0)
			c = ((c >> 1) ^ 0xA001);
		else
			c = (c >> 1);
	}
	return c;
}

function loadFirmware(filename) {
	//var filename = "/opt/iobroker/iobroker-data/files/mysensors.0/firmware/SensorDoorNRF24_v2.1.ino.hex";
    adapter.log.debug("compiling firmware: " + filename);
	try {	
		adapter.readFile(adapter.namespace, 'firmware/' + filename, 'utf8', (err, data) => {
			if (err) {adapter.log.error(err)}
			else {
			//fs.readFile(filename, 'utf8', (err, data) => {
				let fwdata = [];
				let start = 0;
				let end = 0;
				let pos = 0;
				data = data.toString('utf8');
				adapter.log.debug(JSON.stringify(data));
				 
				let hex = data.split("\n");
				adapter.log.debug(JSON.stringify(hex));
						
				for(let l in hex) {
					let line = hex[l].trim();
					if (line.length > 0) {
						while (line.substring(0, 1) != ":")
							line = line.substring(1);
						
						let reclen = parseInt(line.substring(1, 3), 16);
						let offset = parseInt(line.substring(3, 7), 16);
						let rectype = parseInt(line.substring(7, 9), 16);
						let data = line.substring(9, 9 + 2 * reclen);
						let chksum = parseInt(line.substring(9 + (2 * reclen), 9 + (2 * reclen) + 2), 16);
						
						if (rectype == 0) {
							if ((start == 0) && (end == 0)) {
								if (offset % 128 > 0)
									throw new Error("error loading hex file - offset can't be devided by 128");
								start = offset;
								end = offset;
							}
							if (offset < end)
									throw new Error("error loading hex file - offset lower than end");
							
							while (offset > end) {
								fwdata.push(255);
								pos++;
								end++;
							}
							
							for (let i = 0; i < reclen; i++) {
								fwdata.push(parseInt(data.substring(i * 2, (i * 2) + 2), 16));
								pos++;
							}
							end += reclen;
						}
					}
				}	
				
				let pad = end % 128; // ATMega328 has 64 words per page / 128 bytes per page
				for (let i = 0; i < 128 - pad; i++) {
					fwdata.push(255);
					pos++;
					end++;
				}
				
				let blocks = (end - start) / FIRMWARE_BLOCK_SIZE;
				let crc = 0xFFFF;
				
				for (let i = 0; i < blocks * FIRMWARE_BLOCK_SIZE; ++i) {
					let v = crc;
					crc = crcUpdate(crc, fwdata[i]);
				}
				
				adapter.log.debug("loading firmware done. blocks: " + blocks + " / crc: " + crc);
				let payload = [];
				let fwblock = blocks;
				for (let j = 0; j < 10; j++){
					for (let i = 0; i < FIRMWARE_BLOCK_SIZE; i++)
						payload.push(fwdata[fwblock * FIRMWARE_BLOCK_SIZE + i]);
					adapter.log.debug('j=' + j + ': ' + JSON.stringify(payload));
					payload = [];
					fwblock -= 1;            
				}
			}
		}); 
	} catch (err) {
		if (err) adapter.log.error(err);
	} 
}

function pullWord(arr, pos) {
	return arr[pos] + 256 * arr[pos + 1];
}

function payloadParse(str, val, radix){
    let hByte;
    let lByte;

    lByte = str.slice(val*4, val*4 + 2);
    hByte = str.slice(val*4 + 2, val*4 + 4);
    return parseInt((hByte + lByte), radix);
}

function pushWord(arr, val) {
	arr.push(val & 0x00FF);
	arr.push((val  >> 8) & 0x00FF);
}

function sendFirmwareConfigResponse(node_id){
	var payload = [];
	//pushWord(payload, result.type);
	//pushWord(payload, result.version);
	//pushWord(payload, result.blocks);
	//pushWord(payload, result.crc);
}

function send_message(obj_id, state){
    if (typeof state.val === 'boolean') state.val = state.val ? 1 : 0;
    if (state.val === 'true')  state.val = 1;
    if (state.val === 'false') state.val = 0;

    mySensorsInterface.write(
        devices[obj_id].native.id           + ';' +
        //JG: Changed. Always request an ack when sending command 'set' to a node
        //devices[id].native.childId      + ';1;0;' +
        devices[obj_id].native.childId      + ';1;1;' +
        devices[obj_id].native.varTypeNum   + ';' +
        state.val, devices[obj_id].native.ip);
}

function findObjAckFalse(ip, node_id) {
    for (let id in devices) {
        if (devices[id].native &&
            (!ip || ip === devices[id].native.ip) &&
            devices[id].native.id == node_id &&
            devices[id].native.childId !== 255 &&
            devices[id].common.write === true) {
            adapter.getState(id, function (err, state) {
                if (err) adapter.log.error(err);
                if (state && state.val && state.val !== null && state.ack === false) {
                    adapter.log.debug('Obj.ack = false. Send state (' + id + ') to node ' + node_id);
                    send_message(id, state);
                }
            });
        }
    }
}

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    if (!state || state.ack || !mySensorsInterface) return;

    // Warning, state can be null if it was deleted
    adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));
	if (state.val === 'reboot'){
		adapter.log.debug('Reboot node ' + devices[id].native.id);
		mySensorsInterface.write(devices[id].native.id + ';255;3;1;13;1', devices[id].native.ip);
	return;
	}
    if (id === adapter.namespace + '.inclusionOn') {
        setInclusionState(state.val);
        setTimeout(function (val) {
            adapter.setState('inclusionOn', val, true);
        }, 200, state.val);
    } else
    // output to mysensors
    if (devices[id] && devices[id].type === 'state') {
        var arr_id = id.split('.');
        adapter.getState(arr_id[2] + '.' + arr_id[3] + '.255_ARDUINO_NODE.I_PRE_SLEEP_NOTIFICATION', function (err, state1) {
            if (err) adapter.log.error(err);
            if (state1 && state1.val &&
                typeof state1.val === 'number' &&
                state1.val > 0) {   // determined that node can sleep
                adapter.getState(arr_id[2] + '.' + arr_id[3] + '.255_ARDUINO_NODE.I_HEARTBEAT_RESPONSE', function (err, state2) {
                    if (err) adapter.log.error(err);
                    if (state2 && state2.val && state2.val !== null) {  // received hearbeat
                        if ((Date.now() - state2.lc) < state1.val){
                            adapter.log.debug('Node not sleepping. Send data');
                            send_message(id, state);    // node is still awake, sending data
                        } else adapter.log.debug('Node sleepping. Not send data');
                    }
                });
            } else {
                adapter.log.debug('Node real time.');
                send_message(id, state);
            }
        });
    }
});

adapter.on('objectChange', function (id, obj) {
    if (!obj) {
        if (devices[id]) delete devices[id];
    } else {
        if (obj.native.id !== undefined && obj.native.childId !== undefined && obj.native.subType !== undefined) {
            devices[id] = obj;
        }
    }
});

adapter.on('ready', function () {
    main();
});

var presentationDone = false;

function setInclusionState(val) {
    val = val === 'true' || val === true || val === 1 || val === '1';
    inclusionOn = val;

    if (inclusionTimeout) clearTimeout(inclusionTimeout);
    inclusionTimeout = null;

    if (inclusionOn) presentationDone = false;

    if (inclusionOn && adapter.config.inclusionTimeout) {
        inclusionTimeout = setTimeout(function () {
            inclusionOn = false;
            adapter.setState('inclusionOn', false, true);
        }, adapter.config.inclusionTimeout);
    }
}

function findDevice(result, ip, subType) {
    for (var id in devices) {
        if (devices[id].native &&
            (!ip || ip === devices[id].native.ip) &&
            devices[id].native.id == result.id &&
            devices[id].native.childId == result.childId &&
            (subType === false || devices[id].native.varType == result.subType)) {
            return id;
        }
    }
    return -1;
}

function saveResult(id, result, ip, subType) {
    if (id === -1) id = findDevice(result, ip, subType);
    if (id !== -1 && devices[id]) {
        if (devices[id].common.type === 'boolean') {
            result.payload = result.payload === 'true' || result.payload === true || result.payload === '1' || result.payload === 1;
            //result.payload = !!result[i].payload;
        }
        if (devices[id].common.type === 'number')  result.payload = parseFloat(result.payload);

        adapter.log.debug('Set value ' + (devices[id].common.name || id) + ' ' + result.childId + ': ' + result.payload + ' ' + typeof result.payload);
        adapter.setState(id, result.payload, true);

        return id;
    }
    return 0;
}

function reqGetSend(id, result, ip, subType) {
    if (id === -1) id = findDevice(result, ip, subType);
    if (id !== -1 && devices[id]) {
        adapter.getState(id, function (err, state) {
            if (err) adapter.log.error(err);
            if (state && state.val) {
                try {
                    if (typeof state.val === 'boolean') state.val = state.val ? 1 : 0;
                    if (state.val === 'true')  state.val = 1;
                    if (state.val === 'false') state.val = 0;
                    adapter.log.debug('Get value ' + result.id + ' ' + result.childId + ': ' + state.val);
                    mySensorsInterface.write(
                        result.id           + ';' +
                        //result.childId      + ';1;0;' +   // Changed. Always request an ack when sending command 'REQ' to a node
                        result.childId      + ';1;1;' +
                        devices[id].native.varTypeNum   + ';' +
                        state.val, devices[id].native.ip);
                } catch (err) {
                    if (err) adapter.log.error(err);
                    adapter.log.error('Cannot sending!');
                }
            }
        });
        
        return id;
    }
    return 0;
}

function processPresentation(data, ip, port) {
    data = data.toString();
    var result;
    try {
        result = Parses.parse(data);
    } catch (e) {
        adapter.log.error('Cannot parse data: ' + data + '[' + e + ']');
        return null;
    }

    

    if (!result || !result.length) {
        adapter.log.warn('Cannot parse data: ' + data);
        return null;
    }

    for (var i = 0; i < result.length; i++) {
        adapter.log.debug('Got: ' + JSON.stringify(result[i]));

        if (result[i].type === 'presentation' && result[i].subType) {
            adapter.log.debug('Message presentation');
            presentationDone = true;
            // Add new node
            if (inclusionOn) {
                var found = findDevice(result[i], ip) !== -1;
                if (!found) {
                    adapter.log.debug('ID not found. Try to add to to DB');
                    var objs = getMeta(result[i], ip, port, config[ip || 'serial']);
					adapter.log.warn('result[i]: ' + JSON.stringify(result[i]));
					adapter.log.warn('ip: ' + JSON.stringify(ip));
					adapter.log.warn('objs: ' + JSON.stringify(objs));
                    for (var j = 0; j < objs.length; j++) {
                        adapter.log.debug('Check ' + JSON.stringify(devices[adapter.namespace + '.' + objs[j]._id]));
                        if (!devices[adapter.namespace + '.' + objs[j]._id]) { 
                            devices[adapter.namespace + '.' + objs[j]._id] = objs[j];
                            adapter.log.info('Add new object: ' + objs[j]._id + ' - ' + objs[j].common.name);
                            adapter.setObject(objs[j]._id, objs[j], function (err) {
                                if (err) adapter.log.error(err);
                            });
                        }
                    }
                }
            } else {
                adapter.log.warn('ID not found. Inclusion mode OFF: ' + JSON.stringify(result[i]));
            }
            // check if received object exists
        } else if (result[i].type === 'set' && result[i].subType) {
            if (0) {
                adapter.log.debug('Message type is "set". Try to find it in DB...');
                var found = false;
                var foundObjID; // store here ID that suit with parameters to id and childId

                for (var id in devices) {
                    if ((!ip || ip === devices[id].native.ip) &&
                        devices[id].native.id      == result[i].id      &&
                        devices[id].native.childId == result[i].childId &&
                        devices[id].native.varType == result[i].subType) {
                        found = true;
                        adapter.log.debug('Found id = ' + id);
                        break;
                    }
                    if (devices[id].native.id      == result[i].id      &&
                        devices[id].native.childId == result[i].childId){
                        foundObjID = id;
                        adapter.log.debug('Save foundObjID with similar id and childId');
                        adapter.log.debug('devices[foundObjID].native.id      = ' + devices[foundObjID].native.id);
                        adapter.log.debug('devices[foundObjID].native.childId = ' + devices[foundObjID].native.childId);
                    }
                }

                // add new value to existing object
                if (!found && foundObjID) {
                    adapter.log.debug('Object ID: ' + result[i].id + ', childId: ' + result[i].childId + ', subType: ' + result[i].subType + ' not found!');
                    if (inclusionOn) {
                        adapter.log.debug('ID not found. Try to add to to DB');
                        var common_name = devices[foundObjID].common.name.split('.');
                        var objs = getMeta2(result[i], ip, port, config[ip || 'serial'], devices[foundObjID].native.subType, common_name[0]);
                        if (!devices[adapter.namespace + '.' + objs[0]._id]) {
                            devices[adapter.namespace + '.' + objs[0]._id] = objs[0];
                            adapter.log.info('Add new object1: ' + objs[0]._id + ' - ' + objs[0].common.name);
                            adapter.setObject(objs[0]._id, objs[0], function (err) {
                                if (err) adapter.log.error(err);
                            });
                        }
                    } else {
                        adapter.log.warn('ID ignored by presentation, because inclusion mode OFF: ' + JSON.stringify(result[i]));
                    }
                } else {
                    if (!found && !foundObjID) {
                        adapter.log.debug('Object ID: ' + result[i].id + ', childId: ' + result[i].childId + ' not found!');
                    }
                }
            }
            // try to convert value
            var val = result[i].payload;
            if (floatRegEx.test(val)) val = parseFloat(val);
            if (val === 'true')  val = true;
            if (val === 'false') val = false;
            result[i].payload = val;

        } else {
            // try to convert value
            var _val = result[i].payload;
            if (floatRegEx.test(_val)) _val = parseFloat(_val);
            if (_val === 'true')  _val = true;
            if (_val === 'false') _val = false;
            result[i].payload = _val;
        }
    }
    return result;
}


function updateSketchName(id, name) {
    adapter.getObject(id, function (err, obj) {
        if (!obj) {
            obj = {
                type: 'device',
                common: {
                    name: name
                }
            };
        } else if (obj.common.name === name) {
            name = null;
            return;
        }
        obj.common.name = name;
        adapter.setObject(adapter.namespace + '.' + id, obj, function (err) {
        });
    });
}

function main() {
	adapter.getState('info.connection', function (err, state) {
        if (!state || state.val) {
            adapter.setState('info.connection', false, true);
        }
    });
    adapter.config.inclusionTimeout = parseInt(adapter.config.inclusionTimeout, 10) || 0;

    adapter.getState('inclusionOn', function (err, state) {
        setInclusionState(state ? state.val : false);
    });

    // read current existing objects (прочитать текущие существующие объекты)
    adapter.getForeignObjects(adapter.namespace + '.*', 'state', function (err, states) {
        // subscribe on changes
        adapter.subscribeStates('*');
        adapter.subscribeObjects('*');
        devices = states;

        if (!devices[adapter.namespace + '.info.connection'] || !devices[adapter.namespace + '.info.connection'].common ||
            (devices[adapter.namespace + '.info.connection'].common.type === 'boolean' && adapter.config.type !== 'serial') ||
            (devices[adapter.namespace + '.info.connection'].common.type !== 'boolean' && adapter.config.type === 'serial')) {
            adapter.setForeignObject(adapter.namespace + '.info.connection', {
                _id:  'info.connection',
                type: 'state',
                common: {
                    role:  'indicator.connected',
                    name:  adapter.config.type === 'serial' ? 'If connected to my sensors' : 'List of connected gateways',
                    type:  adapter.config.type === 'serial' ? 'boolean' : 'string',
                    read:  true,
                    write: false,
                    def:   false
                },
                native: {

                }
            }, function (err) {
                if (err) adapter.log.error(err);
            });
        }

        mySensorsInterface = new MySensors(adapter.config, adapter.log, function (error) {
            // if object created
            mySensorsInterface.write('0;0;3;0;14;Gateway startup complete');

            // process received data
            mySensorsInterface.on('data', function (data, ip, port) {
                var result = processPresentation(data, ip, port); // update configuration if presentation received

                if (!result) return; 
                
                for (var i = 0; i < result.length; i++) {
                    adapter.log.debug('Message type: ' + result[i].type);
                    if (result[i].subType.indexOf('S_') === 0) {
                        adapter.log.debug('Value type of S_... Out of the loop');
                        return;
                    }
                    var id = findDevice(result[i], ip);
                    if (result[i].type === 'set') {
                        // If set quality
                        if (result[i].subType == 77) {
                            adapter.log.debug('subType = 77');
                            for (var id in devices) {
                                if (devices[id].native &&
                                    (!ip || ip === devices[id].native.ip) &&
                                    devices[id].native.id      == result[i].id &&
                                    devices[id].native.childId == result[i].childId) {
                                    adapter.log.debug('Set quality of ' + (devices[id].common.name || id) + ' ' + result[i].childId + ': ' + result[i].payload + ' ' + typeof result[i].payload);
                                    adapter.setState(id, {q: typeof result[i].payload}, true);
                                }
                            }
                        } else {
                            if (result[i].subType === 'V_LIGHT')  result[i].subType = 'V_STATUS';
                            if (result[i].subType === 'V_DIMMER') result[i].subType = 'V_PERCENTAGE';
                            if (result[i].subType === 'V_DUST_LEVEL') result[i].subType = 'V_LEVEL';

                            saveResult(id, result[i], ip, true);
                        }
                    } else if (result[i].type === 'req') {
                        reqGetSend(id, result[i], ip, true);
                    } else if (result[i].type === 'internal') {
                        var saveValue = false;
                        switch (result[i].subType) {
                            case 'I_DISCOVER_RESPONSE':     		//   21   Discover request
                                adapter.log.info('Node: ' + result[i].id + ' discover request');
                                saveValue = true;
                                break;
								
							case 'I_PRE_SLEEP_NOTIFICATION':     	//   32   Message sent before node is going to sleep
                                adapter.log.info('Timeout pre sleep ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                saveValue = true;
                                break;
                            
                            case 'I_POST_SLEEP_NOTIFICATION':     	//   33   Message sent after node woke up (if enabled)
                                adapter.log.info('Timeout post sleep ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                saveValue = true;
                                break;
                                
                            case 'I_HEARTBEAT_RESPONSE':     		//   22   Heartbeat response
                                adapter.log.info('Hearbeat ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                saveValue = true;
                                break;
                                
                            case 'I_BATTERY_LEVEL':     			//   0   Use this to report the battery level (in percent 0-100).
                                adapter.log.info('Battery level ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                saveValue = true;
                                break;

                            case 'I_TIME':              			//   1   Sensors can request the current time from the Controller using this message. The time will be reported as the seconds since 1970
                                adapter.log.info('Time ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                if (!result[i].ack) {
                                    // send response: internal, ack=1
                                    mySensorsInterface.write(result[i].id + ';' + result[i].childId + ';3;1;1;' + Math.round(new Date().getTime() / 1000), ip);
                                }
                                break;

                            case 'I_SKETCH_VERSION':
                            case 'I_VERSION':           			//   2   Used to request gateway version from controller.
                                adapter.log.info('Version ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                saveValue = true;
                                if (!result[i].ack && result[i].subType === 'I_VERSION') {
                                    // send response: internal, ack=1
                                    mySensorsInterface.write(result[i].id + ';' + result[i].childId + ';3;1;2;' + (adapter.version || 0), ip);
                                }
                                break;

                            case 'I_SKETCH_NAME':           //   2   Used to request gateway version from controller.
                                adapter.log.info('Name  ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                updateSketchName(result[i].id, result[i].payload);
                                saveValue = true;
                                break;

                            case 'I_INCLUSION_MODE':    //   5   Start/stop inclusion mode of the Controller (1=start, 0=stop).
                                adapter.log.info('inclusion mode ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload ? 'STARTED' : 'STOPPED');
                                break;

                            case 'I_CONFIG':            //   6   Config request from node. Reply with (M)etric or (I)mperal back to sensor.
                                result[i].payload = (result[i].payload === 'I') ? 'Imperial' : 'Metric';
                                adapter.log.info('Config ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                config[ip || 'serial'] = config[ip || 'serial'] || {};
                                config[ip || 'serial'].metric = result[i].payload;
                                saveValue = true;
                                break;

                            case 'I_LOG_MESSAGE':       //   9   Sent by the gateway to the Controller to trace-log a message
                                adapter.log.debug('Log ' + (ip ? ' from ' + ip + ' ' : '') + ':' + result[i].payload);
                                break;

                            case 'I_ID_REQUEST':
                                if (inclusionOn) {
                                    // find maximal index
                                    var maxId = 0;
                                    for (var _id in devices) {
                                        if (!devices.hasOwnProperty(_id)) continue;
                                        if (devices[_id].native && (!ip || ip === devices[_id].native.ip) &&
                                            devices[_id].native.id > maxId) {
                                            maxId = devices[_id].native.id;
                                        }
                                    }
                                    maxId++;
                                    if (!result[i].ack) {
                                        // send response: internal, ack=0, I_ID_RESPONSE
                                        mySensorsInterface.write(result[i].id + ';' + result[i].childId + ';3;0;4;' + maxId, ip);
                                    }
                                } else {
                                    adapter.log.warn('Received I_ID_REQUEST, but inclusion mode is disabled');
                                }
                                break;

                            default:
                                adapter.log.info('Received INTERNAL message: ' + result[i].subType + ': ' + result[i].payload);

                        }

                        if (saveValue) {
                            saveResult(id, result[i], ip, true);
                            if (result[i].subType === 'I_HEARTBEAT_RESPONSE'){
                                adapter.log.debug('Send unsent values');
                                findObjAckFalse(ip, result[i].id); 
                            }
                        }
                    } else if (result[i].type === 'stream') {
                        switch (result[i].subType) {
                            case 'ST_FIRMWARE_CONFIG_REQUEST':
								var fwtype = payloadParse(result[i].payload, 0, 10);
								var fwversion = payloadParse(result[i].payload, 1, 10);
								var fwblocks = payloadParse(result[i].payload, 2, 16);
								var fwcrc = payloadParse(result[i].payload, 3, 16);
								var BLVersion = payloadParse(result[i].payload, 4, 10);
								adapter.log.debug('fwtype = ' + fwtype);
								adapter.log.debug('fwversion = ' + fwversion);
								adapter.log.debug('fwblocks = ' + fwblocks);
								adapter.log.debug('fwcrc = ' + fwcrc);
								adapter.log.debug('BLVersion = ' + BLVersion);
								//payloadParse(str, val, radix)
								//sendFirmwareConfigResponse(result[i].id, fwtype, fwversion);
                                break;
                            case 'ST_FIRMWARE_CONFIG_RESPONSE':
                                break;
                            case 'ST_FIRMWARE_REQUEST':
                                break;
                            case 'ST_FIRMWARE_RESPONSE':
                                break;
                            case 'ST_SOUND':
                                break;
                            case 'ST_IMAGE':
                                break;
							case 'ST_FIRMWARE_CONFIRM':
                                break;
							case 'ST_FIRMWARE_RESPONSE_RLE':
                                break;
                        }
                    }
                }
            });

            mySensorsInterface.on('connectionChange', function (isConn, ip, port) {
                adapter.setState('info.connection', isConn, true);
                // try soft request
                if (!presentationDone && isConn) {
                    // request metric system
                    mySensorsInterface.write('0;0;3;0;6;get metric', ip, port);
                    mySensorsInterface.write('0;0;3;0;19;force presentation', ip, port);
                    setTimeout(function () {
                        // send reboot command if still no presentation
                        if (!presentationDone) {
                            mySensorsInterface.write('0;0;3;0;13;force restart', ip, port);
                        }
                    }, 1500);
                }
            });
        });
    });
}
