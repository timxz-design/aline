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
final class VisitMonitor: NSObject, CLLocationManagerDelegate {
  static let shared = VisitMonitor()
  static let enabledKey = "aline.visitMonitoringEnabled"
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
    }
  }

  func stop() {
    UserDefaults.standard.set(false, forKey: VisitMonitor.enabledKey)
    DispatchQueue.main.async {
      self.manager?.stopMonitoringVisits()
    }
  }

  func resumeIfEnabled() {
    if UserDefaults.standard.bool(forKey: VisitMonitor.enabledKey) { start() }
  }

  func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
    VisitStore.append(visit)
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
