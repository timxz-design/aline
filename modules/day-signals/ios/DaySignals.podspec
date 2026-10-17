Pod::Spec.new do |s|
  s.name           = 'DaySignals'
  s.version        = '1.0.0'
  s.summary        = 'iOS visit monitoring (CLVisit) and motion activity history (CMMotionActivity)'
  s.description    = 'Local Expo module for ALINE: arrivals/departures recorded by iOS even while the app is closed, and the 7-day motion activity history.'
  s.license        = 'UNLICENSED'
  s.author         = 'ALINE'
  s.homepage       = 'https://github.com/timxz-design/aline'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreLocation', 'CoreMotion'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
