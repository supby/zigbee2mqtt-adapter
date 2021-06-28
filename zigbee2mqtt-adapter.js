/**
 * zigbee2mqtt-adapter.js - Adapter to use all those zigbee devices via
 * zigbee2mqtt.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

"use strict";

const mqtt = require("mqtt");
const { Adapter, Device, Property, Event } = require("gateway-addon");

const Devices = require("./devices");

const identity = (v) => v;

class MqttProperty extends Property {
  constructor(device, name, propertyDescription) {
    super(device, name, propertyDescription);
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
    this.options = propertyDescription;
  }

  setValue(value) {
    return new Promise((resolve, reject) => {
      super
        .setValue(value)
        .then((updatedValue) => {
          const { toMqtt = identity } = this.options;
          this.device.adapter.publishMessage(`${this.device.id}/set`, {
            [this.name]: toMqtt(updatedValue),
          });
          resolve(updatedValue);
          this.device.notifyPropertyChanged(this);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }
}

class MqttDevice extends Device {
  constructor(adapter, id, modelId) {
    super(adapter, id);
    const description = Devices[modelId];
    this.name = description.name;
    this["@type"] = description["@type"];
    this.modelId = modelId;
    for (const [name, desc] of Object.entries(description.properties || {})) {
      const property = new MqttProperty(this, name, desc);
      this.properties.set(name, property);
    }
    for (const [name, desc] of Object.entries(description.events || {})) {
      this.addEvent(name, desc);
    }
  }
}

class ZigbeeMqttAdapter extends Adapter {
  constructor(addonManager, manifest) {
    super(addonManager, "ZigbeeMqttAdapter", manifest.name);
    this.config = manifest.moziot.config;
    addonManager.addAdapter(this);

    this.client = mqtt.connect(this.config.mqtt);
    this.client.on("error", (error) => console.error("mqtt error", error));
    this.client.on("message", this.handleIncomingMessage.bind(this));
    this.client.subscribe(
      this.config.prefixes.map((prefix) => `${prefix}/bridge/config/devices`)
    );

    this.client.subscribe(
      this.config.prefixes.map((prefix) => `${prefix}/+`)
    );

    for (const prefix of this.config.prefixes) {
      this.client.publish(`${prefix}/bridge/config/devices/get`);
    }
  }

  handleIncomingMessage(topic, data) {
    const msg = JSON.parse(data.toString());
    if (topic.includes('/bridge/config/devices')) {
      for (const device of msg) {
        this.addDevice(device);
      }
    }

    if (!topic.includes('/bridge')) {
      const topicElements = topic.split("/");
      const friendlyName = topicElements[topicElements.length - 1];
      const device = this.getDevice(friendlyName);
      if (!device) {
        console.info(`[handleIncomingMessage] Adding new Device id:${friendlyName}`);
        this.addDeviceFromStateMessage(msg.device);
        return;
      }
      if (msg.action && device.events.get(msg.action)) {
        const event = new Event(
          device,
          msg.action,
          msg[device.events.get(msg.action)]
        );
        device.eventNotify(event);
      }
      for (const key of Object.keys(msg)) {
        const property = device.findProperty(key);
        if (!property) {
          continue;
        }
        const { fromMqtt = identity } = property.options;
        property.setCachedValue(fromMqtt(msg[key]));
        device.notifyPropertyChanged(property);
      }
    }
  }

  getDevice(friendlyName) {
    return this.devices[friendlyName];
  }

  publishMessage(topic, msg) {
    for (const prefix of this.config.prefixes) {
      this.client.publish(`${prefix}/${topic}`, JSON.stringify(msg));
    }
  }

  addDeviceFromStateMessage(info) {
    if (!info) return;

    if (!Devices[info.model]) {
      console.warn(`[addDeviceFromStateMessage] Device id:${info.friendlyName}, model: ${info.model} is not found in description.`);
      return;
    }

    const existingDevice = this.getDevice(info.friendlyName);
    if (existingDevice && existingDevice.modelId === info.model) {
      console.info(`[addDeviceFromStateMessage] Device ${info.friendlyName} already exists`);
      return;
    }

    const device = new MqttDevice(this, info.friendlyName, info.model);
    this.client.subscribe(
      this.config.prefixes.map((prefix) => `${prefix}/${info.friendlyName}`)
    );

    this.handleDeviceAdded(device);
    console.info(
      `New device model:${info.model}, friendlyName:${info.friendlyName} is added.`
    );
  }

  addDevice(info) {
    if (!Devices[info.modelID]) {
      console.warn(`[addDevice] Device id:${info.friendly_name}, model: ${info.modelID} is not found in description.`);
      return;
    }
    const existingDevice = this.getDevice(info.friendly_name);
    if (existingDevice && existingDevice.modelId === info.modelID) {
      console.info(`Device ${info.friendly_name} already exists`);
      return;
    }

    const device = new MqttDevice(this, info.friendly_name, info.modelID);
    this.client.subscribe(
      this.config.prefixes.map((prefix) => `${prefix}/${info.friendly_name}`)
    );

    this.handleDeviceAdded(device);
    console.info(
      `New device model:${info.modelID}, friendlyName:${info.friendly_name} is added.`
    );
  }

  startPairing(_timeoutSeconds) {
    for (const prefix of this.config.prefixes) {
      this.client.publish(`${prefix}/bridge/config/devices/get`);
    }
    // TODO: Set permitJoin
  }

  cancelPairing() {
    // TODO: Clear permitJoin
  }
}

function loadAdapter(addonManager, manifest, _errorCallback) {
  new ZigbeeMqttAdapter(addonManager, manifest);
}

module.exports = loadAdapter;
