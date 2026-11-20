import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { arrivalForVisit, extractRouteDirections, extractStops, matchesDirection, nearbyStops, text, unwrapStopVisits } from "./nearby.js";

interface Env { API_511_KEY?: string; }
const API_511_BASE = "https://api.511.org/transit/";
const MUNI_OPERATOR = "SF";
const STATIC_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const staticCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

async function fetch511(apiKey: string, endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(endpoint, API_511_BASE);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`511 API ${resp.status}: ${resp.statusText}`);
  let text = await resp.text();
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

async function fetch511Static(apiKey: string, endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const cacheKey = `${endpoint}?${new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString()}`;
  const now = Date.now();
  const cached = staticCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = fetch511(apiKey, endpoint, params).catch((error) => {
    staticCache.delete(cacheKey);
    throw error;
  });
  staticCache.set(cacheKey, { expiresAt: now + STATIC_CACHE_TTL_MS, value });
  if (staticCache.size > 100) {
    const oldest = [...staticCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) staticCache.delete(oldest[0]);
  }
  return value;
}

async function getMuniStops(apiKey: string) {
  return extractStops(await fetch511Static(apiKey, "stops", { operator_id: MUNI_OPERATOR }));
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function ok(text: string) { return { content: [{ type: "text" as const, text }] }; }
function fail(err: unknown) { return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }; }

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization,Mcp-Session-Id,x-api-key-511",
};

function createServer(apiKey: string): McpServer {
  const server = new McpServer({ name: "muni-mcp-server", version: "1.0.0" });

  server.registerTool("transit_operators", {
    title: "List 511 Transit Operators", description: "List all transit operators available in the 511 API (BART, Muni, Caltrain, AC Transit, etc.).",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const data: any = await fetch511(apiKey, "operators");
      if (!Array.isArray(data) || !data.length) return ok("No operators found.");
      const lines: string[] = [`# 511 Transit Operators (${data.length})\n`];
      for (const op of data) lines.push(`- **${op.Name}** (${op.Id}) — ${op.Website || "no website"}`);
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_routes", {
    title: "List Muni Routes", description: "List all SF Muni routes (bus, rail, cable car).\n\nArgs:\n  - operator_id: Optional operator ID (default 'SF' for Muni)",
    inputSchema: { operator_id: z.string().default(MUNI_OPERATOR).describe("Operator ID (default SF)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ operator_id }) => {
    try {
      const data: any = await fetch511(apiKey, "routes", { operator_id });
      if (!Array.isArray(data) || !data.length) return ok("No routes found.");
      const lines: string[] = [`# Muni Routes (${data.length})\n`];
      for (const r of data) lines.push(`- **${r.Id}**: ${r.Name}`);
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_stops_nearby", {
    title: "Nearby Muni Stops",
    description: "Find Muni stops near a latitude and longitude. Returns the nearest stop names and IDs with straight-line distances from the requested location in meters.",
    inputSchema: {
      latitude: z.number().min(-90).max(90).describe("WGS84 latitude"),
      longitude: z.number().min(-180).max(180).describe("WGS84 longitude"),
      radius_meters: z.number().positive().max(10000).default(1000).describe("Search radius in meters (default 1000)"),
      operator_id: z.string().default(MUNI_OPERATOR).describe("511 operator ID (default SF)"),
      line_id: z.string().optional().describe("Optional route/line ID to narrow the search"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ latitude, longitude, radius_meters, operator_id, line_id }) => {
    try {
      const stops = operator_id === MUNI_OPERATOR && !line_id
        ? await getMuniStops(apiKey)
        : extractStops(await fetch511Static(apiKey, "stops", { operator_id, ...(line_id ? { line_id } : {}) }));
      const nearby = nearbyStops(stops, latitude, longitude, radius_meters, 25);
      if (!nearby.length) return ok(`No Muni stops found within ${radius_meters} meters.`);
      const lines = [`# Nearby Muni Stops (${nearby.length}, nearest first)\n`, "Distances are straight-line distances from your location.\n"];
      for (const stop of nearby) {
        lines.push(`- **${stop.name}** (stop ${stop.stopCode}) — ${Math.round(stop.meters)} meters away`);
      }
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_departures_nearby", {
    title: "Nearby Muni Departures",
    description: "Find the closest Muni stop serving a route and direction near a location, then return the next real-time arrivals from that one stop. If you provide a route but no direction, this tool lists nearby direction choices so you can ask the rider which destination they want.",
    inputSchema: {
      latitude: z.number().min(-90).max(90).describe("WGS84 latitude of the rider"),
      longitude: z.number().min(-180).max(180).describe("WGS84 longitude of the rider"),
      line_id: z.string().optional().describe("Optional Muni route ID, such as 38 or N"),
      direction: z.string().optional().describe("Optional direction name, destination, or 511 direction ID"),
      radius_meters: z.number().positive().max(10000).default(1000).describe("Maximum stop distance (default 1000 meters)"),
      count: z.number().int().positive().max(10).default(3).describe("Maximum arrivals to return (default 3)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ latitude, longitude, line_id, direction, radius_meters, count }) => {
    try {
      if (direction && !line_id) return ok("Please provide a Muni route as well as the direction.");
      const catalog = await getMuniStops(apiKey);
      let candidates = catalog;
      let selectedDirection: ReturnType<typeof extractRouteDirections>[number] | undefined;

      if (line_id) {
        const patterns = await fetch511Static(apiKey, "patterns", { operator_id: MUNI_OPERATOR, line_id });
        const directions = extractRouteDirections(patterns);
        if (!directions.length) return ok(`I couldn't find route directions for Muni line ${line_id}.`);

        const closestByDirection = (await Promise.all(directions.map(async (routeDirection) => {
          let directionStops = catalog.filter((stop) => routeDirection.stopIds.has(stop.id));
          if (!directionStops.length) {
            const response = await fetch511Static(apiKey, "stops", {
              operator_id: MUNI_OPERATOR,
              line_id,
              Direction_id: routeDirection.id,
            });
            const byId = new Map(catalog.map((stop) => [stop.id, stop]));
            directionStops = extractStops(response).map((stop) => byId.get(stop.id) ?? stop);
          }
          const nearby = nearbyStops(directionStops, latitude, longitude, radius_meters, 1)[0];
          return { direction: routeDirection, stop: nearby };
        }))).filter((item) => item.stop);

        if (!closestByDirection.length) return ok(`No stops for Muni line ${line_id} were found within ${radius_meters} meters.`);

        if (!direction) {
          const options = closestByDirection.sort((a, b) => a.stop!.meters - b.stop!.meters);
          if (options.length > 1) {
            const lines = [`Which direction for Muni line ${line_id} do you want? Nearby options:`];
            for (const option of options.slice(0, 6)) {
              const name = option.direction.labels[0] ?? option.direction.id;
              lines.push(`- ${name}, from ${option.stop!.name} (${Math.round(option.stop!.meters)} meters away)`);
            }
            return ok(lines.join("\n"));
          }
          selectedDirection = options[0].direction;
          candidates = catalog.filter((stop) => selectedDirection!.stopIds.has(stop.id));
        } else {
          const matches = directions.filter((candidate) => matchesDirection(candidate, direction));
          if (matches.length !== 1) {
            const lines = matches.length
              ? [`“${direction}” matches more than one direction for line ${line_id}. Please choose one:`]
              : [`I couldn't match “${direction}” to a direction for Muni line ${line_id}. Available directions:`];
            for (const item of directions) lines.push(`- ${item.labels[0] ?? item.id}`);
            return ok(lines.join("\n"));
          }
          selectedDirection = matches[0];
          candidates = catalog.filter((stop) => selectedDirection!.stopIds.has(stop.id));
          if (!candidates.length) {
            const directionalStops = extractStops(await fetch511Static(apiKey, "stops", {
              operator_id: MUNI_OPERATOR,
              line_id,
              Direction_id: selectedDirection.id,
            }));
            const byId = new Map(catalog.map((stop) => [stop.id, stop]));
            candidates = directionalStops.map((stop) => byId.get(stop.id) ?? stop);
          }
        }
      }

      const closest = nearbyStops(candidates, latitude, longitude, radius_meters, 1)[0];
      if (!closest) return ok(`No Muni stops were found within ${radius_meters} meters${line_id ? ` for line ${line_id}` : ""}.`);

      // Fetch live predictions only for the single selected stop; static stop/pattern data is cached.
      const response = await fetch511(apiKey, "StopMonitoring", { agency: MUNI_OPERATOR, stopCode: closest.stopCode });
      const visits = unwrapStopVisits(response);
      const arrivals = visits.flatMap((visit) => {
        const arrival = arrivalForVisit(visit);
        if (!arrival) return [];
        const journey = visit.MonitoredVehicleJourney ?? visit.monitoredVehicleJourney;
        const realtimeLineRef = text(journey?.LineRef ?? journey?.lineRef);
        if (line_id && normalized(arrival.line) !== normalized(line_id) && normalized(realtimeLineRef) !== normalized(line_id)) return [];
        if (selectedDirection) {
          const directionRef = arrival.direction ?? "";
          const destination = normalized(arrival.destination);
          const directionMatch = directionRef && directionRef === selectedDirection.id;
          const labelMatch = selectedDirection.labels.some((label) => destination.includes(normalized(label)) || normalized(label).includes(destination));
          if (!directionMatch && !labelMatch) return [];
        }
        return [arrival];
      }).sort((a, b) => Date.parse(a.expectedAt) - Date.parse(b.expectedAt)).slice(0, count);

      if (!arrivals.length) return ok(`No live predictions${line_id ? ` for line ${line_id}${selectedDirection ? ` ${selectedDirection.labels[0] ?? selectedDirection.id}` : ""}` : ""} at ${closest.name} right now. I did not substitute scheduled times.`);
      const heading = `# Next Muni arrivals${line_id ? ` — line ${line_id}` : ""}\n\nStop: **${closest.name}** (${Math.round(closest.meters)} meters away)`;
      const lines = [heading];
      for (const arrival of arrivals) {
        lines.push(`- **${arrival.line}** → ${arrival.destination} — ${arrival.etaMinutes === 0 ? "arriving now" : `${arrival.etaMinutes} min`} (expected ${arrival.expectedAt})`);
      }
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_departures", {
    title: "Muni Real-Time Departures", description: "Get real-time departure predictions for a Muni stop.\n\nArgs:\n  - stop_code: The 5-digit stop code\n  - operator_id: Optional (default 'SF')",
    inputSchema: { stop_code: z.string().min(1).describe("Muni stop code (e.g. '15731')"), operator_id: z.string().default(MUNI_OPERATOR).describe("Operator ID (default SF)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ stop_code, operator_id }) => {
    try {
      const data: any = await fetch511(apiKey, "StopMonitoring", { agency: operator_id, stopCode: stop_code });
      const deliveries = data?.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit || data?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit;
      if (!deliveries?.length) return ok(`No departures found for stop ${stop_code}.`);
      const lines: string[] = [`# Departures from Stop ${stop_code}\n`];
      for (const visit of deliveries) {
        const j = visit.MonitoredVehicleJourney; if (!j) continue;
        const call = j.MonitoredCall; const ea = call?.ExpectedArrivalTime || call?.ExpectedDepartureTime;
        let eta = "unknown";
        if (ea) { const m = Math.max(0, Math.round((new Date(ea).getTime() - Date.now()) / 60000)); eta = m === 0 ? "Arriving" : `${m} min`; }
        lines.push(`- **${j.PublishedLineName || j.LineRef}** → ${j.DestinationName || j.DestinationRef} — ${eta}`);
      }
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_line", {
    title: "Muni Line Details", description: "Get details for a specific Muni line including stops.\n\nArgs:\n  - line_id: Route/line ID (e.g. 'N', '14', '38R')\n  - operator_id: Optional (default 'SF')",
    inputSchema: { line_id: z.string().min(1).describe("Muni line/route ID"), operator_id: z.string().default(MUNI_OPERATOR).describe("Operator ID (default SF)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ line_id, operator_id }) => {
    try {
      const data: any = await fetch511(apiKey, "stops", { operator_id, line_id });
      if (!data?.Contents?.dataObjects?.ScheduledStopPoint?.length) {
        const stops = data?.Stops || data?.stops || data;
        if (Array.isArray(stops) && stops.length) { const lines = [`# Line ${line_id} Stops (${stops.length})\n`]; for (const s of stops) lines.push(`- ${s.Name||s.name} (${s.Id||s.id||s.StopId})`); return ok(lines.join("\n")); }
        return ok(`No info found for line ${line_id}.`);
      }
      const stops = data.Contents.dataObjects.ScheduledStopPoint;
      const lines = [`# Line ${line_id} — ${stops.length} stops\n`];
      for (const s of stops) lines.push(`- **${s.Name}** (stop ${s.id||s.Id||""}) — ${s.Url||""}`);
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_alerts", {
    title: "Muni Service Alerts", description: "Get current Muni service alerts, detours, and disruptions.\n\nArgs:\n  - operator_id: Optional (default 'SF')",
    inputSchema: { operator_id: z.string().default(MUNI_OPERATOR).describe("Operator ID (default SF)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ operator_id }) => {
    try {
      const data: any = await fetch511(apiKey, "servicealerts", { agency: operator_id });
      const alerts = data?.Entities || data?.ServiceDelivery?.SituationExchangeDelivery?.Situations?.PtSituationElement || [];
      if (!alerts.length) return ok("No current Muni service alerts.");
      const lines: string[] = ["# Muni Service Alerts\n"];
      for (const a of alerts) {
        if (a.Alert) { const h = a.Alert.HeaderText?.Translations?.[0]?.Text || a.Alert.HeaderText?.Translation?.[0]?.Text || "Alert"; const d = a.Alert.DescriptionText?.Translations?.[0]?.Text || a.Alert.DescriptionText?.Translation?.[0]?.Text || ""; lines.push(`## ${h}`); if (d) lines.push(d); lines.push(""); }
        else if (a.Summary || a.Description) { lines.push(`## ${a.Summary||"Alert"}`); if (a.Description) lines.push(a.Description); lines.push(""); }
      }
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_vehicles", {
    title: "Muni Vehicle Positions", description: "Get real-time GPS positions of Muni vehicles.\n\nArgs:\n  - operator_id: Optional (default 'SF')",
    inputSchema: { operator_id: z.string().default(MUNI_OPERATOR).describe("Operator ID (default SF)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ operator_id }) => {
    try {
      const data: any = await fetch511(apiKey, "VehicleMonitoring", { agency: operator_id });
      const acts = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.VehicleActivity || data?.ServiceDelivery?.VehicleMonitoringDelivery?.VehicleActivity || data?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
      if (!acts.length) return ok("No vehicle positions available.");
      const lines = [`# Muni Vehicles (${acts.length})\n`]; const lim = Math.min(acts.length, 50);
      for (let i = 0; i < lim; i++) { const v = acts[i].MonitoredVehicleJourney; if (!v) continue; lines.push(`- **${v.PublishedLineName||v.LineRef||"?"}** → ${v.DestinationName||v.DestinationRef||"?"} | ${v.VehicleLocation?.Latitude||"?"}, ${v.VehicleLocation?.Longitude||"?"}`); }
      if (acts.length > lim) lines.push(`\n_...and ${acts.length-lim} more_`);
      return ok(lines.join("\n"));
    } catch (err) { return fail(err); }
  });

  server.registerTool("muni_schedule", {
    title: "Muni Timetable", description: "Get the timetable/schedule for a specific Muni line.\n\nArgs:\n  - line_id: Route/line ID (e.g. 'N', '14', '38R')\n  - operator_id: Optional (default 'SF')",
    inputSchema: { line_id: z.string().min(1).describe("Muni line/route ID"), operator_id: z.string().default(MUNI_OPERATOR).describe("Operator ID (default SF)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ line_id, operator_id }) => {
    try {
      const data: any = await fetch511(apiKey, "timetable", { operator_id, line_id });
      if (!data) return ok(`No schedule found for line ${line_id}.`);
      const journeys = data?.Content?.TimetableFrame?.VehicleJourneys?.ServiceJourney || data?.ContentFrame?.vehicleJourneys || data?.journeys || [];
      if (Array.isArray(journeys) && journeys.length) {
        const lines = [`# Schedule for Line ${line_id} (${journeys.length} trips)\n`]; const lim = Math.min(journeys.length, 20);
        for (let i = 0; i < lim; i++) { const j = journeys[i]; const dep = j.calls?.Call?.[0]?.Departure?.Time || j.DepartureTime || "?"; lines.push(`- Trip ${i+1}: departs ${dep}`); }
        if (journeys.length > lim) lines.push(`\n_...and ${journeys.length-lim} more trips_`);
        return ok(lines.join("\n"));
      }
      return ok(`# Schedule for Line ${line_id}\n\n${JSON.stringify(data, null, 2).slice(0, 3000)}`);
    } catch (err) { return fail(err); }
  });

  return server;
}

function addCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(JSON.stringify({
        name: "muni-mcp-server", version: "1.0.0",
        description: "SF Muni real-time transit data via MCP",
        mcp_endpoint: "/mcp",
        auth: "Pass your 511.org API key via the x-api-key-511 header. Get a free key at https://511.org/open-data/token",
        tools: ["transit_operators", "muni_routes", "muni_departures", "muni_stops_nearby", "muni_departures_nearby", "muni_line", "muni_alerts", "muni_vehicles", "muni_schedule"],
      }, null, 2), { headers: { "Content-Type": "application/json", ...CORS } });
    }
    if (url.pathname !== "/mcp") return new Response(JSON.stringify({ error: "Not found. MCP endpoint is at /mcp" }), { status: 404, headers: { "Content-Type": "application/json", ...CORS } });
    if (request.method !== "POST") return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { "Content-Type": "application/json", ...CORS } });

    const apiKey = request.headers.get("x-api-key-511") || env.API_511_KEY || null;
    if (!apiKey) return new Response(JSON.stringify({ error: "No 511 API key. Set x-api-key-511 header. Free key at https://511.org/open-data/token" }), { status: 401, headers: { "Content-Type": "application/json", ...CORS } });

    try {
      const server = createServer(apiKey);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      return addCors(response);
    } catch (err: any) {
      return new Response(JSON.stringify({ error: String(err), stack: err?.stack }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
    }
  },
};
