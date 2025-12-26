// src/scheduler/agenda.js
const Agenda = require("agenda");

let agenda;

function createAgenda(mongoUri) {
  agenda = new Agenda({
    db: {
      address: mongoUri,
      collection: "agenda_jobs",
    },
    processEvery: "1 seconds",
  });

  return agenda;
}

function getAgenda() {
  if (!agenda) throw new Error("Agenda not initialized");
  return agenda;
}

module.exports = { createAgenda, getAgenda };
