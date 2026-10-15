import ExpoModulesCore
import NetworkExtension

/// Current Wi-Fi network via NEHotspotNetwork.fetchCurrent — Apple's supported
/// API since iOS 14. The deprecated CNCopyCurrentNetworkInfo that NetInfo uses
/// returned nothing on iOS 26 even with the entitlement and location granted.
///
/// Requires the com.apple.developer.networking.wifi-info entitlement and
/// location permission (precise). Resolves null when not on Wi-Fi or when iOS
/// withholds it.
public class WifiInfoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WifiInfo")

    AsyncFunction("fetchCurrent") { (promise: Promise) in
      NEHotspotNetwork.fetchCurrent { network in
        guard let network = network else {
          promise.resolve(nil)
          return
        }
        promise.resolve([
          "ssid": network.ssid,
          "bssid": network.bssid
        ])
      }
    }
  }
}
