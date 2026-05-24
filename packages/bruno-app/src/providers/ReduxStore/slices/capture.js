import { createSlice } from '@reduxjs/toolkit';

/**
 * Live HTTP capture state (Phase 3b of the Proxyman roadmap).
 *
 * Events arrive from main over `main:capture-event` and are dispatched
 * into here via useIpcEvents. The capture proxy emits two events per
 * roundtrip (a "request" phase then a "response" phase, sharing an id),
 * so we merge by id to keep one row per request that fills out when the
 * response lands.
 *
 * The events list is capped (defensive — high-traffic captures can flood
 * the renderer) by dropping oldest when over the limit.
 */

const MAX_EVENTS = 500;

const initialState = {
  running: false,
  port: null,
  panelOpen: false,
  events: [], // newest first; each entry is the merged request+response record
  rules: [], // Phase 5: Map Local / Map Remote / breakpoint
  pendingBreakpoints: [] // Phase 5b: requests held by the proxy awaiting user action
};

export const captureSlice = createSlice({
  name: 'capture',
  initialState,
  reducers: {
    setStatus: (state, action) => {
      const { running, port } = action.payload || {};
      state.running = !!running;
      state.port = typeof port === 'number' ? port : null;
    },

    addEvent: (state, action) => {
      const ev = action.payload;
      if (!ev || !ev.id) return;

      const existingIdx = state.events.findIndex((e) => e.id === ev.id);
      if (existingIdx >= 0) {
        // Merge — response phase typically lands on top of the earlier request phase.
        const merged = {
          ...state.events[existingIdx],
          ...ev,
          // Preserve the original request record if the new event only carries response data.
          request: ev.request || state.events[existingIdx].request,
          response: ev.response || state.events[existingIdx].response
        };
        state.events[existingIdx] = merged;
      } else {
        state.events.unshift(ev);
        if (state.events.length > MAX_EVENTS) {
          state.events.length = MAX_EVENTS;
        }
      }
    },

    removeEvent: (state, action) => {
      const id = action.payload;
      state.events = state.events.filter((e) => e.id !== id);
    },

    clearEvents: (state) => {
      state.events = [];
    },

    openPanel: (state) => {
      state.panelOpen = true;
    },

    closePanel: (state) => {
      state.panelOpen = false;
    },

    addRule: (state, action) => {
      state.rules.push(action.payload);
    },

    updateRule: (state, action) => {
      const { id, patch } = action.payload;
      const idx = state.rules.findIndex((r) => r.id === id);
      if (idx >= 0) state.rules[idx] = { ...state.rules[idx], ...patch };
    },

    removeRule: (state, action) => {
      state.rules = state.rules.filter((r) => r.id !== action.payload);
    },

    setRules: (state, action) => {
      state.rules = Array.isArray(action.payload) ? action.payload : [];
    },

    addBreakpoint: (state, action) => {
      // De-dupe by id in case main re-emits on reconnect.
      if (state.pendingBreakpoints.some((b) => b.id === action.payload.id)) return;
      state.pendingBreakpoints.push(action.payload);
    },

    resolveBreakpoint: (state, action) => {
      state.pendingBreakpoints = state.pendingBreakpoints.filter((b) => b.id !== action.payload);
    }
  }
});

export const {
  setStatus,
  addEvent,
  removeEvent,
  clearEvents,
  openPanel,
  closePanel,
  addRule,
  updateRule,
  removeRule,
  setRules,
  addBreakpoint,
  resolveBreakpoint
} = captureSlice.actions;

export default captureSlice.reducer;
