// src/neural_net.js

const { NN } = require('../config');

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function weightCount() {
  return (
    NN.INPUTS * NN.HIDDEN1 + NN.HIDDEN1 +
    NN.HIDDEN1 * NN.HIDDEN2 + NN.HIDDEN2 +
    NN.HIDDEN2 * NN.OUTPUTS + NN.OUTPUTS
  );
}

function randomWeights() {
  const n = weightCount();
  const w = new Float32Array(n);  // Float32 = half memory, faster V8 typed-array ops
  for (let i = 0; i < n; i++) {
    w[i] = (Math.random() - 0.5) * 2;
  }
  return w;
}

function decide(weights, inputs) {
  let idx = 0;

  const h1 = new Float64Array(NN.HIDDEN1);
  for (let i = 0; i < NN.HIDDEN1; i++) {
    let sum = 0;
    for (let j = 0; j < NN.INPUTS; j++) {
      sum += inputs[j] * weights[idx++];
    }
    sum += weights[idx++];
    h1[i] = sigmoid(sum);
  }

  const h2 = new Float64Array(NN.HIDDEN2);
  for (let i = 0; i < NN.HIDDEN2; i++) {
    let sum = 0;
    for (let j = 0; j < NN.HIDDEN1; j++) {
      sum += h1[j] * weights[idx++];
    }
    sum += weights[idx++];
    h2[i] = sigmoid(sum);
  }

  const out = new Float64Array(NN.OUTPUTS);
  for (let i = 0; i < NN.OUTPUTS; i++) {
    let sum = 0;
    for (let j = 0; j < NN.HIDDEN2; j++) {
      sum += h2[j] * weights[idx++];
    }
    sum += weights[idx++];
    out[i] = sigmoid(sum);
  }

  const toSigned = v => (v * 2) - 1; // [0,1] -> [-1,1]

  return {
    fwd: out[0] > 0.5,
    back: out[1] > 0.5,
    left: out[2] > 0.5,
    right: out[3] > 0.5,
    jump: out[4] > 0.5,
    attack: out[5] > 0.5,
    sprint: out[6] > 0.5,
    yawDelta: toSigned(out[7]),
    pitchDelta: toSigned(out[8]),
  };
}

function toJSON(weights) {
  return Array.from(weights);
}

function fromJSON(arr) {
  return new Float32Array(arr);
}

module.exports = {
  weightCount,
  randomWeights,
  decide,
  toJSON,
  fromJSON,
};