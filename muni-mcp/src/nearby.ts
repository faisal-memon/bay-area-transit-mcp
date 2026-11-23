export interface NearbyStop {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  stopCode: string;
}

export interface NearbyStopResult extends NearbyStop {
  meters: number;
}

export interface RouteDirection {
  id: string;
  labels: string[];
  stopIds: Set<string>;
}

type AnyObject = Record<string, any>;

export function asArray<T = AnyObject>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value == null ? [] : [value as T];
}

export function text(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const object = value as AnyObject;
    return text(object.ref ?? object.Ref ?? object.id ?? object.Id ?? object.value ?? object.Value);
  }
  return undefined;
}

function collectionAt(object: AnyObject | undefined, ...keys: string[]): AnyObject[] {
  if (!object) return [];
  for (const key of keys) {
    const value = object[key];
    if (value == null) continue;
    if (Array.isArray(value)) return value as AnyObject[];
    if (typeof value === "object") {
      const singulars = new Set(keys.map((candidate) => candidate.toLowerCase().replace(/s$/, "")));
      const nested = Object.entries(value as AnyObject).find(([childKey]) => singulars.has(childKey.toLowerCase().replace(/s$/, "")));
      if (nested) return asArray<AnyObject>(nested[1]);
    }
    return [value as AnyObject];
  }
  return [];
}

export function extractStops(response: unknown): NearbyStop[] {
  const root = (response ?? {}) as AnyObject;
  const contents = root.Contents ?? root.contents ?? root;
  const dataObjects = contents.dataObjects ?? contents.DataObjects ?? contents;
  const serviceFrame = dataObjects.ServiceFrame ?? dataObjects.serviceFrame ?? dataObjects;
  const stops = Array.isArray(response)
    ? response as AnyObject[]
    : collectionAt(serviceFrame, "scheduledStopPoints", "ScheduledStopPoint", "stops", "Stops");
  return stops.flatMap((stop) => {
    const location = stop.Location ?? stop.location ?? stop.Centroid?.Location ?? stop.Place?.Centroid?.Location ?? {};
    const latitude = Number(stop.Latitude ?? stop.latitude ?? location.Latitude ?? location.latitude);
    const longitude = Number(stop.Longitude ?? stop.longitude ?? location.Longitude ?? location.longitude);
    const id = text(stop.id ?? stop.Id ?? stop.StopId ?? stop.stop_id ?? stop.ScheduledStopPointRef);
    if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      id,
      name: text(stop.Name ?? stop.name ?? stop.Description) ?? "Unnamed stop",
      latitude,
      longitude,
      stopCode: text(stop.StopCode ?? stop.stopCode ?? stop.stop_code ?? stop.PublicCode ?? stop.Extensions?.StopCode ?? stop.extensions?.stopCode) ?? id,
    }];
  });
}

export function distanceMeters(latitude: number, longitude: number, stopLatitude: number, stopLongitude: number): number {
  const radians = (value: number) => value * Math.PI / 180;
  const earthMeters = 6_371_000;
  const dLat = radians(stopLatitude - latitude);
  const dLon = radians(stopLongitude - longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latitude)) * Math.cos(radians(stopLatitude)) * Math.sin(dLon / 2) ** 2;
  return earthMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function nearbyStops(stops: NearbyStop[], latitude: number, longitude: number, radiusMeters: number, limit = 25): NearbyStopResult[] {
  return stops.map((stop) => ({
    ...stop,
    meters: distanceMeters(latitude, longitude, stop.latitude, stop.longitude),
  })).filter((stop) => stop.meters <= radiusMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, limit);
}

export function extractRouteDirections(response: unknown): RouteDirection[] {
  const root = (response ?? {}) as AnyObject;
  const contents = root.Contents ?? root.contents ?? root;
  const dataObjects = contents.dataObjects ?? contents.DataObjects ?? contents;
  const serviceFrame = dataObjects.ServiceFrame ?? dataObjects.serviceFrame ?? dataObjects;
  const directions = collectionAt(serviceFrame, "directions", "Directions", "Direction");
  const patterns = collectionAt(serviceFrame, "journeyPatterns", "JourneyPatterns", "ServiceJourneyPattern");
  const result = new Map<string, RouteDirection>();

  const add = (idValue: unknown, labels: unknown[], stopIds: string[] = []) => {
    const id = text(idValue);
    if (!id) return;
    const direction = result.get(id) ?? { id, labels: [], stopIds: new Set<string>() };
    for (const labelValue of labels) {
      const label = text(labelValue)?.trim();
      if (label && !direction.labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) direction.labels.push(label);
    }
    for (const stopId of stopIds) direction.stopIds.add(stopId);
    result.set(id, direction);
  };

  for (const direction of directions) {
    add(direction.id ?? direction.Id ?? direction.DirectionId ?? direction.DirectionRef, [direction.Name, direction.name]);
  }

  for (const pattern of patterns) {
    const directionId = text(pattern.DirectionRef ?? pattern.directionRef ?? pattern.DirectionId);
    const display = pattern.DestinationDisplayView ?? pattern.destinationDisplayView ?? {};
    const labels = [
      pattern.Name,
      pattern.name,
      display.FrontText,
      display.FontText,
      display.frontText,
      pattern.DestinationName,
    ];
    const points = pattern.PointsInSequence ?? pattern.pointsInSequence ?? {};
    const stopPoints = [
      ...collectionAt(points, "StopPointInJourneyPattern", "stopPointInJourneyPattern"),
      ...collectionAt(points, "TimingPointInJourneyPattern", "timingPointInJourneyPattern"),
    ];
    const stopIds = stopPoints.flatMap((point) => {
      const id = text(point.ScheduledStopPointRef ?? point.StopPointRef ?? point.stopPointRef ?? point.ref);
      return id ? [id] : [];
    });
    add(directionId, labels, stopIds);
  }
  return [...result.values()];
}

export function matchesDirection(direction: RouteDirection, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return direction.id.toLowerCase() === normalized || direction.labels.some((label) => label.toLowerCase().includes(normalized));
}

export function unwrapStopVisits(response: unknown): AnyObject[] {
  const root = (response ?? {}) as AnyObject;
  const siri = root.Siri ?? root.siri ?? root;
  const serviceDelivery = siri.ServiceDelivery ?? siri.serviceDelivery ?? {};
  const monitoring = serviceDelivery.StopMonitoringDelivery ?? serviceDelivery.stopMonitoringDelivery ?? {};
  return collectionAt(monitoring, "MonitoredStopVisit", "monitoredStopVisit");
}

export function arrivalForVisit(visit: AnyObject): { line: string; direction?: string; destination: string; expectedAt: string; etaMinutes: number } | undefined {
  const journey = visit.MonitoredVehicleJourney ?? visit.monitoredVehicleJourney;
  const call = journey?.MonitoredCall ?? journey?.monitoredCall;
  if (!journey || !call) return undefined;
  const line = text(journey.PublishedLineName ?? journey.LineRef ?? journey.lineRef);
  const destination = text(journey.DestinationName ?? journey.DestinationRef ?? journey.destinationName) ?? "destination not reported";
  const expectedAt = text(call.ExpectedArrivalTime ?? call.ExpectedDepartureTime ?? call.expectedArrivalTime ?? call.expectedDepartureTime);
  if (!line || !expectedAt) return undefined;
  const expectedMs = Date.parse(expectedAt);
  if (!Number.isFinite(expectedMs) || expectedMs < Date.now() - 60_000) return undefined;
  return {
    line,
    direction: text(journey.DirectionRef ?? journey.directionRef),
    destination,
    expectedAt,
    etaMinutes: Math.max(0, Math.round((expectedMs - Date.now()) / 60_000)),
  };
}
