import CoreLocation
import CoreMotion
import ExpoModulesCore
import UIKit

// MARK: - Visit queue

/// Visits iOS reported, persisted until JS uploads them. iOS can deliver a
/// visit while the app is suspended or relaunched in the background with no JS
/// running yet, so they wait here (UserDefaults survives relaunches). JS reads
/// with `pendingVisits()` and removes them with `ackVisits(count)` only after a
/// successful upload — nothing is lost if the network is down.
enum VisitStore {
  static let key = "aline.pendingVisits"
  static let maxItems = 500

  static func append(_ visit: CLVisit) {
    var items = all()
    var item: [String: Double] = [
      "lat": visit.coordinate.latitude,
      "lon": visit.coordinate.longitude,
      "accuracy": visit.horizontalAccuracy,
      "recordedAt": Date().timeIntervalSince1970 * 1000,
    ]
    // distantPast / distantFuture mean "unknown" / "still there".
    if visit.arrivalDate != Date.distantPast {
      item["arrival"] = visit.arrivalDate.timeIntervalSince1970 * 1000
    }
    if visit.departureDate != Date.distantFuture {
      item["departure"] = visit.departureDate.timeIntervalSince1970 * 1000
    }
    items.append(item)
    if items.count > maxItems { items.removeFirst(items.count - maxItems) }
    UserDefaults.standard.set(items, forKey: key)
  }

  /// "Left this spot" observed by the stop fence (iOS never sent the visit's
  /// departure). Uploaded like a visit that only has a departure.
  static func appendDeparture(lat: Double, lon: Double, radius: Double, at: Date) {
    var items = all()
    items.append([
      "lat": lat,
      "lon": lon,
      "accuracy": radius,
      "recordedAt": Date().timeIntervalSince1970 * 1000,
      "departure": at.timeIntervalSince1970 * 1000,
    ])
    if items.count > maxItems { items.removeFirst(items.count - maxItems) }
    UserDefaults.standard.set(items, forKey: key)
  }

  static func all() -> [[String: Double]] {
    return UserDefaults.standard.array(forKey: key) as? [[String: Double]] ?? []
  }

  static func ack(_ count: Int) {
    var items = all()
    items.removeFirst(min(max(count, 0), items.count))
    UserDefaults.standard.set(items, forKey: key)
  }
}

// MARK: - Visit monitor

/// Owns the CLLocationManager for visit monitoring. iOS keeps monitoring
/// across app launches and relaunches the app in the background to deliver a
/// visit; the app delegate subscriber below re-attaches this delegate at launch
/// so those deliveries are caught.
///
/// Stop fence: iOS often reports arriving somewhere but never the departure,
/// so short stops (lunch nearby) vanish. On every arrival we put one small
/// exit-only region around the spot; leaving it wakes the app and records the
/// departure. One fence at a time, identified by `stopRegionId` so it never
/// touches the app's place geofences (expo-location).
final class VisitMonitor: NSObject, CLLocationManagerDelegate {
  static let shared = VisitMonitor()
  static let enabledKey = "aline.visitMonitoringEnabled"
  static let stopKey = "aline.stopFence"          // [lat, lon] of the armed fence
  static let stopRegionId = "aline.stop"
  static let stopRadius: CLLocationDistance = 100  // about the smallest iOS honours
  private var manager: CLLocationManager?

  func start() {
    UserDefaults.standard.set(true, forKey: VisitMonitor.enabledKey)
    DispatchQueue.main.async {
      if self.manager == nil {
        let m = CLLocationManager()
        m.delegate = self
        self.manager = m
      }
      self.manager?.startMonitoringVisits()
      self.rearmStopFence()
    }
  }

  func stop() {
    UserDefaults.standard.set(false, forKey: VisitMonitor.enabledKey)
    DispatchQueue.main.async {
      self.manager?.stopMonitoringVisits()
      self.clearStopFence()
    }
  }

  func resumeIfEnabled() {
    if UserDefaults.standard.bool(forKey: VisitMonitor.enabledKey) { start() }
  }

  func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
    VisitStore.append(visit)
    if visit.departureDate == Date.distantFuture {
      armStopFence(lat: visit.coordinate.latitude, lon: visit.coordinate.longitude)
    } else {
      clearStopFence()  // iOS reported the departure itself
    }
  }

  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
    // Region events reach every location manager in the app: only ours counts.
    guard region.identifier == VisitMonitor.stopRegionId,
          let circle = region as? CLCircularRegion else { return }
    VisitStore.appendDeparture(lat: circle.center.latitude, lon: circle.center.longitude,
                               radius: circle.radius, at: Date())
    clearStopFence()
  }

  func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
    if region?.identifier == VisitMonitor.stopRegionId { clearStopFence() }
  }

  private func armStopFence(lat: Double, lon: Double) {
    guard let m = manager,
          CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
    let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                                  radius: VisitMonitor.stopRadius, identifier: VisitMonitor.stopRegionId)
    region.notifyOnEntry = false
    region.notifyOnExit = true
    m.startMonitoring(for: region)  // same identifier replaces the previous fence
    UserDefaults.standard.set([lat, lon], forKey: VisitMonitor.stopKey)
  }

  /// The fence can be dropped by the system or by a geofence re-sync; put it
  /// back on launch if we're still waiting for a departure.
  private func rearmStopFence() {
    guard let m = manager,
          let c = UserDefaults.standard.array(forKey: VisitMonitor.stopKey) as? [Double], c.count == 2,
          !m.monitoredRegions.contains(where: { $0.identifier == VisitMonitor.stopRegionId }) else { return }
    armStopFence(lat: c[0], lon: c[1])
  }

  private func clearStopFence() {
    UserDefaults.standard.removeObject(forKey: VisitMonitor.stopKey)
    guard let m = manager else { return }
    for r in m.monitoredRegions where r.identifier == VisitMonitor.stopRegionId {
      m.stopMonitoring(for: r)
    }
  }
}

/// Re-arms visit monitoring on every launch, including background relaunches
/// iOS does to deliver a visit.
public class DaySignalsAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    VisitMonitor.shared.resumeIfEnabled()
    return true
  }
}

// MARK: - Module

public class DaySignalsModule: Module {
  private let activityManager = CMMotionActivityManager()

  public func definition() -> ModuleDefinition {
    Name("DaySignals")

    /// Needs "Always" location; a no-op for iOS without it.
    Function("startVisitMonitoring") { () -> Bool in
      guard CLLocationManager.significantLocationChangeMonitoringAvailable() else { return false }
      VisitMonitor.shared.start()
      return true
    }

    Function("stopVisitMonitoring") {
      VisitMonitor.shared.stop()
    }

    Function("pendingVisits") { () -> [[String: Double]] in
      return VisitStore.all()
    }

    Function("ackVisits") { (count: Int) in
      VisitStore.ack(count)
    }

    Function("isMotionActivityAvailable") { () -> Bool in
      return CMMotionActivityManager.isActivityAvailable()
    }

    /// The OS-recorded motion activity between two times (ms since epoch).
    /// iOS keeps about 7 days, recorded whether or not the app was running.
    /// Each entry marks a change of activity starting at `start`.
    AsyncFunction("queryMotionActivity") { (fromMs: Double, toMs: Double, promise: Promise) in
      guard CMMotionActivityManager.isActivityAvailable() else {
        promise.resolve([])
        return
      }
      let from = Date(timeIntervalSince1970: fromMs / 1000)
      let to = Date(timeIntervalSince1970: toMs / 1000)
      self.activityManager.queryActivityStarting(from: from, to: to, to: OperationQueue.main) { activities, error in
        if let error = error {
          promise.reject("E_MOTION", error.localizedDescription)
          return
        }
        let out: [[String: Any]] = (activities ?? []).map { a in
          let kind: String
          if a.automotive { kind = "driving" }
          else if a.cycling { kind = "cycling" }
          else if a.running { kind = "running" }
          else if a.walking { kind = "walking" }
          else if a.stationary { kind = "stationary" }
          else { kind = "unknown" }
          return [
            "start": a.startDate.timeIntervalSince1970 * 1000,
            "kind": kind,
            "confidence": a.confidence.rawValue,
          ]
        }
        promise.resolve(out)
      }
    }
  }
}
