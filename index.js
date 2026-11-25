import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:geolocator_android/geolocator_android.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'package:flutter_ringtone_player/flutter_ringtone_player.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'auth_screens.dart';
import 'dart:convert';
import 'dart:io';
import 'dart:async';
import 'package:socket_io_client/socket_io_client.dart' as IO;

void main() => runApp(DriverApp());

class DriverApp extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Driver SaaS',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(primarySwatch: Colors.green),
      home: AuthGate(mainBuilder: (token, driver, logout) => MainTabPage(token: token, driver: driver, onLogout: logout)),
    );
  }
}

class MainTabPage extends StatefulWidget {
  final String token;
  final Map<String, dynamic> driver;
  final VoidCallback onLogout;
  MainTabPage({required this.token, required this.driver, required this.onLogout});
  @override
  _MainTabPageState createState() => _MainTabPageState();
}

class _Period {
  final DateTime start, end; // end is exclusive
  final String l1, l2;
  _Period(this.start, this.end, this.l1, this.l2);
}

// ========== KARNATAKA FARE BREAKDOWN WIDGET ==========
class FareBreakdownWidget extends StatelessWidget {
  final Map<String, dynamic>? breakdown;
  final dynamic totalFare;
  final String vehicleType;
  const FareBreakdownWidget({this.breakdown, this.totalFare, this.vehicleType = 'TAXI'});

  @override
  Widget build(BuildContext context) {
    if (breakdown == null || breakdown!.isEmpty) {
      return Container(
        padding: EdgeInsets.all(8),
        decoration: BoxDecoration(color: Colors.green.shade50, borderRadius: BorderRadius.circular(8)),
        child: Row(children: [
          Icon(Icons.currency_rupee, color: Colors.green, size: 18),
          SizedBox(width: 4),
          Text("Fare Rs.${totalFare ?? '--'}", style: TextStyle(fontWeight: FontWeight.bold)),
          Spacer(),
          Text("Karnataka Govt Rate", style: TextStyle(fontSize: 9, color: Colors.black54)),
        ]),
      );
    }
    // FIXED: Support both new keys (base_fare/included_km/distance_charge) from pricing_KARNATAKA.js and old keys
    final raw = breakdown!;
    final baseFareVal = raw['base_fare'] ?? raw['min_fare'] ?? 0;
    final includedKmVal = raw['included_km'] ?? raw['min_km'] ?? raw['base_km'] ?? 0;
    final perKmVal = raw['per_km_rate'] ?? raw['per_km'] ?? 0;
    final extraKmRaw = raw['extra_km'] ?? raw['chargeable_km'] ?? 0;
    final double extraKmNum = (extraKmRaw is num) ? extraKmRaw.toDouble() : (double.tryParse('$extraKmRaw') ?? 0.0);
    final extraChargeVal = raw['distance_charge'] ?? raw['extra_km_charge'] ?? (extraKmNum * (perKmVal is num ? perKmVal.toDouble() : 0));
    final waitingCharge = raw['waiting_charge'] ?? 0;
    final billableWaiting = raw['billable_waiting_min'] ?? 0;
    final waitingFree = raw['waiting_free_min'] ?? 5;

    String fmt(dynamic v) {
      if (v == null) return '--';
      if (v is num) return v % 1 == 0 ? v.toStringAsFixed(0) : v.toStringAsFixed(2);
      return v.toString();
    }

    return Container(
      padding: EdgeInsets.all(10),
      decoration: BoxDecoration(color: Colors.grey.shade50, borderRadius: BorderRadius.circular(10), border: Border.all(color: Colors.grey.shade300)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(Icons.receipt_long, size: 16, color: Colors.green.shade700),
          SizedBox(width: 6),
          Text("Karnataka Govt Fare", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.green.shade800)),
          Spacer(),
          Container(padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2), decoration: BoxDecoration(color: Colors.green.shade100, borderRadius: BorderRadius.circular(6)),
              child: Text(vehicleType, style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold))),
        ]),
        Divider(height: 12),
        _row("Base fare", "${fmt(includedKmVal)}km", "₹${fmt(baseFareVal)}"),
        if (extraKmNum > 0.01) _row("Extra distance", "${extraKmNum.toStringAsFixed(2)}km × ₹${fmt(perKmVal)}", "₹${fmt(extraChargeVal)}"),
        if ((billableWaiting is num ? billableWaiting : 0) > 0) _row("Waiting", "${fmt(billableWaiting)}min (free ${fmt(waitingFree)}min)", "₹${fmt(waitingCharge)}"),        Divider(height: 12),
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text("Total", style: TextStyle(fontWeight: FontWeight.bold)),
          Text("₹$totalFare", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Colors.green.shade800)),
        ]),
        SizedBox(height: 4),
        Text("Fare as set by the Karnataka government notification. You keep 100% of it.",
            style: TextStyle(fontSize: 10, color: Colors.black54)),
      ]),
    );
  }

  Widget _row(String label, String sub, String amt) {
    return Padding(
      padding: EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
          Text(sub, style: TextStyle(fontSize: 10, color: Colors.black54)),
        ])),
        Text(amt, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

class _MainTabPageState extends State<MainTabPage> {
  int _currentIndex = 0;
  Position? _pos;
  bool _online = false;
  bool _busy = false; // true while a button request is in flight
  bool _reqDialogOpen = false;
  bool _soundOn = true; // ringer on/off (speaker icon in the top bar)
  bool _ringing = false;
  Timer? _ringTimer;
  Timer? _vibTimer;
  bool _testMode = false; // skips the 'near pickup' check (one-phone testing)
  static const double _arriveMeters = 100;
  final ValueNotifier<int> _tick = ValueNotifier<int>(0);
  StreamSubscription<Position>? _posSub; // location stream that runs as an Android foreground service
  DateTime _lastSent = DateTime.fromMillisecondsSinceEpoch(0);
  Timer? _rideTimer;
  IO.Socket? socket;
  String _status = "Offline - Tap GO ONLINE";
  bool _showTopDropdown = false;
  Map<String, dynamic>? _activeRide;
  final Set<String> _declined = {}; // rides the driver declined (do not show again)
  MapController _mapCtrl = MapController();
  String backendUrl = "https://saas-backend-avz2.onrender.com";
  late final String driverId = widget.driver['driver_id'].toString();
  String get driverName => '${widget.driver['name'] ?? driverId}';
  List<LatLng> _route = [];
  // Orders screen (earnings + history), all calculated from this driver's real rides
  List<Map<String, dynamic>> _orders = [];
  int _ordMode = 0; // 0 = Day, 1 = Week, 2 = Month
  int _ordIdx = -1; // selected period, -1 = latest
  String _ordTab = 'COMPLETED';

  // Wallet & UPI QR - Direct Bank
  Map<String,dynamic>? _wallet;
  bool _walletLoading=false;
  List _walletTxns=[];
  String? _driverUpiId;
  final _upiCtrl=TextEditingController();
  bool _upiSaving=false;
  String? _qrDataUrl;
  final ScrollController _chipCtrl = ScrollController();

  static const _jsonHeaders = {'Content-Type': 'application/json'};

  @override
  void initState() {
    super.initState();
    _getLoc();
    _connectSocket();
    _startRidePolling();
    _loadHistory();
    // Load wallet once, not in build
    Future.microtask(() {
      _loadWallet();
      _loadUpiId();
    });
  }

  // ---------- helpers ----------
  String _rideStatus(Map<String, dynamic>? r) => (r?['status'] ?? '').toString().toUpperCase();

  bool _isFinished(Map<String, dynamic>? r) {
    final s = _rideStatus(r);
    return s == 'CANCELLED' || s == 'COMPLETED';
  }

  void _toast(String msg, {Color color = Colors.black87, int secs = 3}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).hideCurrentSnackBar();
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg), backgroundColor: color, duration: Duration(seconds: secs)));
  }

  LatLng? _pt(dynamic p) {
    try {
      return LatLng((p['lat'] as num).toDouble(), (p['lng'] as num).toDouble());
    } catch (_) {
      return null;
    }
  }

  String _place(dynamic p, String fallback) {
    try {
      final n = p['name'] ?? p['address'] ?? p['label'];
      if (n != null && n.toString().isNotEmpty) return n.toString();
    } catch (_) {}
    return fallback;
  }

  String? _s(dynamic v) {
    if (v == null) return null;
    final t = v.toString().trim();
    return t.isEmpty ? null : t;
  }

  // pickup / drop text from whatever the server sent, else the reverse-geocoded text
  String? _textFor(Map<String, dynamic> r, String side) {
    final saved = _s(r['_${side}_text']);
    if (saved != null) return saved;
    String? fromMap(dynamic m) {
      if (m is Map) {
        for (final k in ['name', 'address', 'label', 'display_name', 'place']) {
          final v = _s(m[k]);
          if (v != null) return v;
        }
        return null;
      }
      return _s(m);
    }

    final direct = fromMap(r[side]);
    if (direct != null) return direct;
    final alts = side == 'from'
        ? ['pickup', 'pickup_address', 'pickup_location', 'from_address', 'from_name', 'source', 'origin']
        : ['drop', 'drop_address', 'drop_location', 'to_address', 'to_name', 'destination', 'dest'];
    for (final k in alts) {
      final v = fromMap(r[k]);
      if (v != null) return v;
    }
    return null;
  }

  Future<void> _resolveAddresses() async {
    final r = _activeRide;
    if (r == null) return;
    for (final side in ['from', 'to']) {
      if (_textFor(r, side) != null) continue;
      final p = _pt(r[side]);
      if (p == null) continue;
      try {
        final res = await http
            .get(Uri.parse('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${p.latitude}&lon=${p.longitude}'),
            headers: {'User-Agent': 'com.saas.driver_app'})
            .timeout(Duration(seconds: 6));
        if (res.statusCode == 200) {
          final d = jsonDecode(res.body);
          final name = _s(d['display_name']);
          if (name != null && mounted && identical(_activeRide, r)) {
            r['_${side}_text'] = name.split(',').take(3).join(',').trim();
            _tick.value++;
            setState(() {});
          }
        }
      } catch (_) {}
    }
  }

  Widget _dlgRow(IconData icon, Color color, String label, String text) {
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Icon(icon, color: color, size: 22),
      SizedBox(width: 10),
      Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: TextStyle(fontSize: 11, color: Colors.black54, fontWeight: FontWeight.bold)),
            Text(text, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          ])),
    ]);
  }

  void _startRing({int seconds = 30}) {
    if (!_soundOn) return;
    _ringTimer?.cancel();
    if (!_ringing) {
      _ringing = true;
      try {
        FlutterRingtonePlayer()
            .play(android: AndroidSounds.alarm, ios: IosSounds.glass, looping: true, volume: 1.0, asAlarm: true)
            .catchError((_) {});
      } catch (_) {}
    }
    _vibTimer?.cancel();
    _vibTimer = Timer.periodic(Duration(milliseconds: 900), (_) => HapticFeedback.heavyImpact()); // pulse with the sound
    _ringTimer = Timer(Duration(seconds: seconds), _stopRing); // never ring forever
  }

  void _stopRing() {
    _ringTimer?.cancel();
    _vibTimer?.cancel();
    if (!_ringing) return;
    _ringing = false;
    try {
      FlutterRingtonePlayer().stop().catchError((_) {});
    } catch (_) {}
  }

  void _toggleSound() {
    setState(() => _soundOn = !_soundOn);
    if (!_soundOn) {
      _stopRing();
    } else if (_reqDialogOpen) {
      _startRing();
    } else {
      _startRing(seconds: 1); // short preview so you can hear the volume
    }
    _toast(_soundOn ? "Ringer ON" : "Ringer OFF", secs: 1);
  }

  void _showRequestDialog() {
    if (_reqDialogOpen || _activeRide == null || !mounted) return;
    _reqDialogOpen = true;
    setState(() {}); // hides the bottom panel while the popup is open
    _startRing();
    showDialog(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => WillPopScope(
            onWillPop: () async => false,
            child: ValueListenableBuilder<int>(
                valueListenable: _tick,
                builder: (c, _, __) {
                  final r = _activeRide;
                  return AlertDialog(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    insetPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 24),
                    titlePadding: EdgeInsets.fromLTRB(20, 18, 20, 4),
                    contentPadding: EdgeInsets.fromLTRB(20, 8, 20, 4),
                    title: Row(children: [
                      Icon(Icons.local_taxi, color: Colors.green),
                      SizedBox(width: 8),
                      Expanded(child: Text("New ride request", maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)))
                    ]),
                    content: r == null
                        ? Text("Ride is no longer available")
                        : SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                      _dlgRow(Icons.trip_origin, Colors.blue, "FROM", _textFor(r, 'from') ?? "Finding pickup address..."),
                      SizedBox(height: 12),
                      _dlgRow(Icons.location_on, Colors.red, "TO", _textFor(r, 'to') ?? "Finding drop address..."),
                      SizedBox(height: 12),
                      // KARNATAKA FARE BREAKDOWN - server calculated
                      FareBreakdownWidget(
                        breakdown: r['fare_breakdown'] is Map ? Map<String,dynamic>.from(r['fare_breakdown']) : null,
                        totalFare: r['fare'],
                        vehicleType: r['vehicle_type'] ?? 'TAXI',
                      ),
                      if (r['vehicle_type'] != null) ...[
                        SizedBox(height: 8),
                        _dlgRow(Icons.local_taxi, Colors.orange, "VEHICLE", r['vehicle_type'] == 'AUTO' ? "Auto (Govt Rate)" : "Taxi (Govt Rate)"),
                      ],
                      if (r['booked_for_other'] == true) ...[
                        SizedBox(height: 12),
                        _dlgRow(Icons.person, Colors.purple, "PASSENGER (booked by customer)", "${r['passenger_name'] ?? ''}  ${r['passenger_phone'] ?? ''}"),
                      ],
                    ])),
                    actions: [
                      TextButton(
                          onPressed: () {
                            _reqDialogOpen = false;
                            Navigator.pop(ctx);
                            _decline();
                          },
                          child: Text("DECLINE", style: TextStyle(color: Colors.red))),
                      ElevatedButton(
                          onPressed: r == null
                              ? null
                              : () {
                            _reqDialogOpen = false;
                            Navigator.pop(ctx);
                            _accept();
                          },
                          style: ElevatedButton.styleFrom(backgroundColor: Colors.blue),
                          child: Text("ACCEPT", style: TextStyle(color: Colors.white))),
                    ],
                  );
                })))
        .then((_) {
      _reqDialogOpen = false;
      _stopRing();
    });
  }

  void _closeRequestDialog() {
    if (_reqDialogOpen && mounted) {
      _reqDialogOpen = false;
      _stopRing();
      Navigator.of(context, rootNavigator: true).pop();
    }
  }

  // distance in metres from the driver to a ride point (null if unknown)
  double? _distTo(dynamic point) {
    final t = _pt(point);
    if (t == null || _pos == null) return null;
    return Geolocator.distanceBetween(_pos!.latitude, _pos!.longitude, t.latitude, t.longitude);
  }

  String _fmtDist(double m) => m < 1000 ? "${m.round()} m" : "${(m / 1000).toStringAsFixed(1)} km";

  bool get _nearPickup {
    if (_testMode) return true;
    final d = _distTo(_activeRide?['from']);
    return d != null && d <= _arriveMeters;
  }

  Future<void> _navigate(dynamic point) async {
    final t = _pt(point);
    if (t == null) {
      _toast("No location available for this ride");
      return;
    }
    try {
      final ok = await launchUrl(Uri.parse('google.navigation:q=${t.latitude},${t.longitude}&mode=d'), mode: LaunchMode.externalApplication);
      if (ok) return;
    } catch (_) {}
    try {
      await launchUrl(Uri.parse('https://www.google.com/maps/dir/?api=1&destination=${t.latitude},${t.longitude}&travelmode=driving'),
          mode: LaunchMode.externalApplication);
    } catch (_) {
      _toast("Could not open maps app", color: Colors.red);
    }
  }

  // ---------- location / socket / polling ----------
  Future<void> _getLoc() async {
    try {
      var p = await Geolocator.checkPermission();
      if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
      var pos = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
      if (mounted) setState(() => _pos = pos);
      try {
        _mapCtrl.move(LatLng(pos.latitude, pos.longitude), 15);
      } catch (_) {}
    } catch (e) {}
  }

  void _connectSocket() {
    socket = IO.io(backendUrl, IO.OptionBuilder().setTransports(['websocket']).enableAutoConnect().build());
    socket!.connect();
    socket!.onConnect((_) => print("Driver socket connected"));
    socket!.on('ride:request', (data) {
      if (mounted && _online) _handleNewRide(data);
    });
    socket!.on('ride:cancelled', (data) {
      if (!mounted || _activeRide == null) return;
      try {
        final d = Map<String, dynamic>.from(data);
        if (d['ride_id'] == _activeRide!['ride_id'] && d['cancelled_by'] != 'driver') {
          _closeRequestDialog();
          setState(() {
            _activeRide = null;
            _route = [];
            _status = "Ride cancelled by customer";
          });
          _toast("Customer cancelled the ride", color: Colors.red);
        }
      } catch (_) {}
    });
    socket!.on('ride:accepted', (data) {
      if (!mounted || _activeRide == null) return;
      try {
        final d = Map<String, dynamic>.from(data);
        if (d['ride_id'] == _activeRide!['ride_id'] && d['driver_id'] != driverId) {
          _closeRequestDialog();
          setState(() {
            _activeRide = null;
            _route = [];
            _status = "Ride taken by another driver";
          });
        }
      } catch (_) {}
    });
  }

  void _startRidePolling() {
    _rideTimer = Timer.periodic(Duration(seconds: 3), (t) async {
      if (!_online || _busy) return;
      try {
        var res = await http.get(Uri.parse("$backendUrl/rides")).timeout(Duration(seconds: 4));
        if (res.statusCode != 200 || !mounted) return;
        List rides = jsonDecode(res.body);
        if (_activeRide != null) {
          final id = _activeRide!['ride_id'];
          final match = rides.cast<dynamic>().firstWhere((r) => r['ride_id'] == id, orElse: () => null);
          if (match != null) {
            final serverStatus = (match['status'] ?? '').toString().toUpperCase();
            if (serverStatus == 'CANCELLED') {
              _closeRequestDialog();
              setState(() {
                _activeRide = null;
                _route = [];
                _status = "Ride cancelled by customer";
              });
              _toast("Customer cancelled the ride", color: Colors.red);
            }
          }
          return;
        }
        var now = DateTime.now().millisecondsSinceEpoch;
        var pending = rides.where((r) {
          var st = (r['status'] ?? '').toString().toUpperCase();
          var statusOk = st == 'REQUESTED' || st == 'SEARCHING';
          var isNew = false;
          try {
            isNew = now - DateTime.parse(r['created_at']).millisecondsSinceEpoch < 5 * 60 * 1000;
          } catch (e) {
            isNew = true;
          }
          var noDriver = r['driver_id'] == null || r['driver_id'] == '' || r['driver_id'] == driverId;
          return statusOk && noDriver && isNew && !_declined.contains(r['ride_id']);
        }).toList();
        pending.sort((a, b) {
          try {
            return DateTime.parse(b['created_at']).compareTo(DateTime.parse(a['created_at']));
          } catch (_) {
            return 0;
          }
        });
        if (pending.isNotEmpty && mounted) _handleNewRide(pending.first);
      } catch (e) {}
    });
  }

  void _handleNewRide(data) {
    if (_activeRide != null && !_isFinished(_activeRide)) return;
    final ride = Map<String, dynamic>.from(data);
    if (_declined.contains(ride['ride_id'])) return;
    ride['status'] = _rideStatus(ride).isEmpty ? 'REQUESTED' : _rideStatus(ride);
    setState(() {
      _activeRide = ride;
      _status = "New ride request";
      _currentIndex = 0;
    });
    _getRoute();
    _resolveAddresses();
    WidgetsBinding.instance.addPostFrameCallback((_) => _showRequestDialog());
  }

  Future<void> _getRoute({bool toDrop = false}) async {
    if (_pos == null || _activeRide == null) return;
    final to = _pt(toDrop ? _activeRide!['to'] : _activeRide!['from']);
    if (to == null) return;
    final from = LatLng(_pos!.latitude, _pos!.longitude);
    try {
      var url = Uri.parse(
          'https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson');
      var res = await http.get(url).timeout(Duration(seconds: 5));
      if (res.statusCode == 200) {
        var d = jsonDecode(res.body);
        if (d['routes'] != null && d['routes'].isNotEmpty) {
          var coords = d['routes'][0]['geometry']['coordinates'] as List;
          if (mounted) setState(() => _route = coords.map((c) => LatLng(c[1].toDouble(), c[0].toDouble())).toList());
        }
      }
    } catch (e) {
      if (mounted) setState(() => _route = [from, to]);
    }
  }

  // ---------- online / offline ----------
  Future<void> _goOnline() async {
    try {
      final r = await Api.get('/driver/me', token: widget.token);
      if (r.ok) {
        final c = r.body['compliance'];
        final isSuper = r.body['is_super_admin'] == true || (c is Map && c['is_super_admin'] == true) || (r.body['driver'] is Map && r.body['driver']['is_super_admin'] == true);
        if (isSuper) {
          print('SUPER ADMIN BYPASS - skipping compliance block');
        } else if (c is Map && c['ok'] != true) {
          final issues = (c['issues'] as List? ?? []).map((e) => '$e').toList();
          if (mounted) {
            showDialog(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: Text("You cannot go online yet"),
                  content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                    ...issues.map((i) => Padding(padding: EdgeInsets.only(bottom: 6), child: Text("• $i"))),
                    SizedBox(height: 8),
                    Text("Please contact support to update your documents.", style: TextStyle(fontSize: 12, color: Colors.black54)),
                  ]),
                  actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: Text("OK"))],
                ));
          }
          return;
        }
        final sub = r.body['subscription'];
        if (sub is Map && sub['blocked'] == true && !isSuper) {
          if (mounted) {
            showDialog(
                context: context,
                builder: (ctx) => AlertDialog(
                      title: Text("Platform fee pending"),
                      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text("${sub['block_message'] ?? 'Please clear your dues to go online.'}"),
                        if ('${sub['pay_instructions'] ?? ''}'.isNotEmpty) ...[SizedBox(height: 10), Text("${sub['pay_instructions']}", style: TextStyle(fontSize: 13, color: Colors.black87))],
                        SizedBox(height: 10),
                        Text("Once you have paid, the dues are cleared and you can go online.", style: TextStyle(fontSize: 12, color: Colors.black54)),
                      ]),
                      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: Text("OK"))],
                    ));
          }
          return;
        }
        if (c is Map && (c['warnings'] as List? ?? []).isNotEmpty) _toast("${(c['warnings'] as List).first}", color: Colors.orange.shade800, secs: 6);
      }
    } catch (_) {}
    if (_pos == null) await _getLoc();
    setState(() {
      _online = true;
      _status = "Online - waiting for rides";
    });
    await _startTracking();
  }

  Future<void> _startTracking() async {
    await _posSub?.cancel();
    final settings = AndroidSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 0,
      intervalDuration: Duration(seconds: 4),
      foregroundNotificationConfig: ForegroundNotificationConfig(
        notificationTitle: "You are online",
        notificationText: "Sharing your location so riders can find you",
        enableWakeLock: true,
      ),
    );
    _posSub = Geolocator.getPositionStream(locationSettings: settings).listen(_onPosition, onError: (e) {
      _toast("Location error: $e", color: Colors.red);
    });
  }

  void _onPosition(Position p) {
    if (mounted) setState(() => _pos = p);
    final now = DateTime.now();
    if (now.difference(_lastSent).inMilliseconds < 3500) return;
    _lastSent = now;
    _sendLocation(p);
  }

  Future<void> _sendLocation(Position p) async {
    try {
      final res = await http
          .post(Uri.parse("$backendUrl/driver/location"),
          headers: {..._jsonHeaders, 'Authorization': 'Bearer ${widget.token}'},
          body: jsonEncode({'driver_id': driverId, 'lat': p.latitude, 'lng': p.longitude, 'online': true}))
          .timeout(Duration(seconds: 10));
      if (res.statusCode == 403 && _online) {
        String msg = "You can no longer go online.";
        try {
          msg = jsonDecode(res.body)['error'].toString();
        } catch (_) {}
        _toast(msg, color: Colors.red, secs: 8);
        _goOffline();
        return;
      }
    } catch (_) {}
    socket?.emit('driver:location:update', {'tenant_id': 'TENANT_01', 'driver_id': driverId, 'lat': p.latitude, 'lng': p.longitude});
  }

  void _goOffline() {
    _posSub?.cancel();
    _posSub = null;
    setState(() {
      _online = false;
      _status = "Offline - Tap GO ONLINE";
    });
  }

  // ---------- ride actions ----------
  Future<void> _accept() async {
    if (_activeRide == null || _busy) return;
    setState(() => _busy = true);
    try {
      var rid = _activeRide!["ride_id"];
      var res = await http
          .post(Uri.parse("$backendUrl/rides/$rid/accept"), headers: _jsonHeaders, body: jsonEncode({'driver_id': driverId}))
          .timeout(Duration(seconds: 20));
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (mounted) {
          setState(() {
            _activeRide!['status'] = 'ACCEPTED';
            _activeRide!['driver_id'] = driverId;
            _status = "Accepted - go to pickup";
          });
        }
        _getRoute();
      } else {
        _toast("Accept failed (${res.statusCode})", color: Colors.red, secs: 5);
      }
    } catch (e) {
      _toast("Could not reach server", color: Colors.red, secs: 5);
    }
    if (mounted) setState(() => _busy = false);
  }

  void _decline() {
    if (_activeRide == null) return;
    _declined.add(_activeRide!['ride_id'].toString());
    setState(() {
      _activeRide = null;
      _route = [];
      _status = "Online - waiting for rides";
    });
  }

  String _shortErr(http.Response res) {
    try {
      final e = jsonDecode(res.body)['error'];
      if (e != null) return e.toString();
    } catch (_) {}
    return "Request failed (${res.statusCode})";
  }

  Future<http.Response> _postStatus(dynamic rid, String s, {String? pin}) {
    final path = {'ARRIVED': 'arrived', 'STARTED': 'start', 'COMPLETED': 'complete'}[s] ?? s.toLowerCase();
    return http
        .post(Uri.parse("$backendUrl/rides/$rid/$path"),
        headers: _jsonHeaders, body: jsonEncode({'driver_id': driverId, if (pin != null) 'pin': pin}))
        .timeout(Duration(seconds: 20));
  }

  Future<void> _updateStatus(String s, {String? pin}) async {
    if (_activeRide == null || _busy) return;
    setState(() => _busy = true);
    try {
      var rid = _activeRide!["ride_id"];
      var res = await _postStatus(rid, s, pin: pin);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (mounted) {
          setState(() {
            _activeRide!['status'] = s;
            if (s == "ARRIVED") _status = "Arrived - ask customer for PIN";
            if (s == "STARTED") {
              _status = "Trip in progress";
              final d = _pt(_activeRide!['to']);
              if (d != null && _pos != null) _route = [LatLng(_pos!.latitude, _pos!.longitude), d];
              _getRoute(toDrop: true);
            }
            if (s == "COMPLETED") {
              // Don't null yet - show collect dialog first
              final fareToCollect = _activeRide?['fare'] ?? 55;
              _status = "Collect ₹$fareToCollect";
              _loadHistory();
              if (mounted && _activeRide != null) {
                Future.delayed(Duration(milliseconds: 300), () {
                  if (mounted) _showCollectCashDialog(_activeRide!);
                });
              } else {
                _activeRide = null;
                _route = [];
              }
            }
          });
        }
      } else {
        _toast(_shortErr(res), color: Colors.red, secs: 5);
      }
    } catch (e) {
      _toast("Could not reach server", color: Colors.red, secs: 5);
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _startWithPin() async {
    final ctrl = TextEditingController();
    final pin = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text("Enter the trip PIN"),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            Text("Ask the customer for the 4 digit PIN shown in their app.", style: TextStyle(fontSize: 13, color: Colors.black54)),
            SizedBox(height: 10),
            TextField(
                controller: ctrl,
                autofocus: true,
                keyboardType: TextInputType.number,
                maxLength: 4,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(border: OutlineInputBorder(), hintText: "4 digit PIN")),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: Text("Back")),
            ElevatedButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: Text("START")),
          ],
        ));
    if (pin == null) return;
    if (pin.length != 4) {
      _toast("Enter the 4 digit PIN");
      return;
    }
    _updateStatus("STARTED", pin: pin);
  }

  Future<void> _cancel(String reason) async {
    if (_activeRide == null) return;
    try {
      var rid = _activeRide!["ride_id"];
      var res = await http
          .post(Uri.parse("$backendUrl/rides/$rid/cancel"),
          headers: _jsonHeaders, body: jsonEncode({'cancelled_by': 'driver', 'reason': reason}))
          .timeout(Duration(seconds: 20));
      if (res.statusCode >= 200 && res.statusCode < 300) {
        _declined.add(rid.toString());
        setState(() {
          _activeRide = null;
          _route = [];
          _status = "Cancelled: $reason";
        });
      } else {
        _toast("Cancel failed (${res.statusCode})", color: Colors.red);
      }
    } catch (e) {
      _toast("Cancel failed: $e", color: Colors.red);
    }
  }

  void _cancelDialog() {
    String r = "Rain";
    showDialog(
        context: context,
        builder: (ctx) => StatefulBuilder(
            builder: (ctx, setD) => AlertDialog(
              title: Text("Cancel ride?"),
              content: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: ["Rain", "Long pickup", "Customer not reachable", "Vehicle issue", "Other"]
                      .map((x) => RadioListTile<String>(
                      dense: true,
                      title: Text(x),
                      value: x,
                      groupValue: r,
                      onChanged: (v) => setD(() => r = v!)))
                      .toList()),
              actions: [
                TextButton(onPressed: () => Navigator.pop(ctx), child: Text("Back")),
                ElevatedButton(
                    onPressed: () {
                      Navigator.pop(ctx);
                      _cancel(r);
                    },
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
                    child: Text("CANCEL RIDE", style: TextStyle(color: Colors.white)))
              ],
            )));
  }

  static const _months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  static const _fullMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  static const _wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  String _money(dynamic v) {
    final n = (v is num) ? v : (num.tryParse('$v') ?? 0);
    return n == n.toInt() ? "${n.toInt()}" : n.toStringAsFixed(2);
  }

  DateTime? _rideTime(Map r) {
    for (final k in ['completed_at', 'cancelled_at', 'created_at']) {
      final v = r[k];
      if (v == null) continue;
      try {
        return DateTime.parse(v.toString()).toLocal();
      } catch (_) {}
    }
    return null;
  }

  Map<String, dynamic> _sub = {}; // platform subscription summary from the server

  Future<void> _loadSubscription() async {
    try {
      final r = await Api.get('/driver/subscription', token: widget.token);
      if (r.ok && mounted) setState(() => _sub = r.body);
    } catch (_) {}
  }

  Future<void> _loadHistory() async {
    _loadSubscription();
    try {
      final res = await http.get(Uri.parse("$backendUrl/rides")).timeout(Duration(seconds: 8));
      if (res.statusCode != 200) return;
      final list = <Map<String, dynamic>>[];
      for (final r in (jsonDecode(res.body) as List)) {
        final st = (r['status'] ?? '').toString().toUpperCase();
        if (r['driver_id'] != driverId || (st != 'COMPLETED' && st != 'CANCELLED')) continue;
        final m = Map<String, dynamic>.from(r);
        list.add({
          "ride_id": "${r['ride_id']}",
          "fare": num.tryParse('${r['fare']}') ?? 0,
          "fare_breakdown": r['fare_breakdown'],
          "status": st,
          "time": _rideTime(r),
          "from": _textFor(m, 'from'),
          "to": _textFor(m, 'to'),
          "fromPt": _pt(r['from']),
          "toPt": _pt(r['to']),
          "reason": "${r['cancel_reason'] ?? r['reason'] ?? ''}"
        });
      }
      list.sort((a, b) {
        final ta = a['time'] as DateTime?, tb = b['time'] as DateTime?;
        if (ta == null || tb == null) return 0;
        return tb.compareTo(ta);
      });
      for (final o in list) {
        for (final side in ['from', 'to']) {
          final pt = o['${side}Pt'] as LatLng?;
          if (o[side] == null && pt != null) o[side] = _addrCache[_ck(pt)];
        }
      }
      if (mounted) setState(() => _orders = list);
      _resolveOrderAddresses();
    } catch (_) {}
  }

  final Map<String, String> _addrCache = {};
  bool _resolvingOrders = false;

  String _ck(LatLng p) => "${p.latitude.toStringAsFixed(4)},${p.longitude.toStringAsFixed(4)}";

  Future<String?> _reverse(LatLng p) async {
    final k = _ck(p);
    if (_addrCache.containsKey(k)) return _addrCache[k];
    try {
      final res = await http
          .get(Uri.parse('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${p.latitude}&lon=${p.longitude}'),
          headers: {'User-Agent': 'com.saas.driver_app'})
          .timeout(Duration(seconds: 6));
      if (res.statusCode == 200) {
        final name = _s(jsonDecode(res.body)['display_name']);
        if (name != null) {
          final t = name.split(',').take(3).join(',').trim();
          _addrCache[k] = t;
          return t;
        }
      }
    } catch (_) {}
    return null;
  }

  Future<void> _resolveOrderAddresses() async {
    if (_resolvingOrders) return;
    _resolvingOrders = true;
    int lookups = 0;
    try {
      for (final o in List<Map<String, dynamic>>.from(_orders)) {
        for (final side in ['from', 'to']) {
          if (o[side] != null) continue;
          final pt = o['${side}Pt'] as LatLng?;
          if (pt == null) continue;
          final cached = _addrCache[_ck(pt)];
          if (cached != null) {
            o[side] = cached;
            continue;
          }
          if (lookups >= 40 || !mounted) continue;
          lookups++;
          final t = await _reverse(pt);
          if (t != null) o[side] = t;
          if (mounted) setState(() {});
          await Future.delayed(Duration(milliseconds: 1100));
        }
      }
      if (mounted) setState(() {});
    } finally {
      _resolvingOrders = false;
    }
  }

  List<_Period> _periods() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final out = <_Period>[];
    if (_ordMode == 0) {
      for (int i = 13; i >= 0; i--) {
        final d = DateTime(today.year, today.month, today.day - i);
        out.add(_Period(d, DateTime(d.year, d.month, d.day + 1), _wd[d.weekday - 1], "${d.day}"));
      }
    } else if (_ordMode == 1) {
      final monday = DateTime(today.year, today.month, today.day - (today.weekday - 1));
      String dd(DateTime x) => x.day.toString().padLeft(2, '0');
      for (int i = 7; i >= 0; i--) {
        final st = DateTime(monday.year, monday.month, monday.day - 7 * i);
        final last = DateTime(st.year, st.month, st.day + 6);
        out.add(_Period(st, DateTime(st.year, st.month, st.day + 7), _months[st.month - 1], "${dd(st)}-${dd(last)}"));
      }
    } else {
      for (int i = 11; i >= 0; i--) {
        final st = DateTime(now.year, now.month - i, 1);
        out.add(_Period(st, DateTime(st.year, st.month + 1, 1), _months[st.month - 1], "${st.year}"));
      }
    }
    return out;
  }

  double get _chipW => _ordMode == 1 ? 92 : (_ordMode == 2 ? 64 : 56);

  void _scrollToChip(int i) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_chipCtrl.hasClients) return;
      final max = _chipCtrl.position.maxScrollExtent;
      final vp = _chipCtrl.position.viewportDimension;
      double target = i * (_chipW + 8) - (vp / 2 - _chipW / 2);
      if (target < 0) target = 0;
      if (target > max) target = max;
      _chipCtrl.animateTo(target, duration: Duration(milliseconds: 250), curve: Curves.easeOut);
    });
  }

  @override
  void dispose() {
    _posSub?.cancel();
    _rideTimer?.cancel();
    socket?.disconnect();
    _stopRing();
    _chipCtrl.dispose();
    _tick.dispose();
    super.dispose();
  }


  void _showProfileSheet() {
    setState(() {
      _showTopDropdown = !_showTopDropdown;
    });
  }

  void _hideDropdown() {
    if (_showTopDropdown) {
      setState(() {
        _showTopDropdown = false;
      });
    }
  }

  void _showProfileMenu() {
    _hideDropdown();
    showModalBottomSheet(
      context: context,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return Container(
          padding: EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: Icon(Icons.person_outline),
                title: Text("Profile Info"),
                subtitle: Text("Photo, Name, Phone, Gender, DOB"),
                trailing: Icon(Icons.arrow_forward_ios, size: 16),
                onTap: () {
                  Navigator.pop(ctx);
                  _showProfileInfo();
                },
              ),
              ListTile(
                leading: Icon(Icons.badge, color: Colors.blue),
                title: Text("UrbanRide ID Card"),
                subtitle: Text("Name, Mobile, License Validity"),
                trailing: Icon(Icons.arrow_forward_ios, size: 16),
                onTap: () {
                  Navigator.pop(ctx);
                  _showIDCard();
                },
              ),
              ListTile(
                leading: Icon(Icons.folder),
                title: Text("Documents"),
                subtitle: Text("View & Re-upload from Gallery"),
                trailing: Icon(Icons.arrow_forward_ios, size: 16),
                onTap: () {
                  Navigator.pop(ctx);
                  _showDocuments();
                },
              ),
            ],
          ),
        );
      },
    );
  }

  void _showProfileInfo() {
    final d = widget.driver ?? {};
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return Container(
          padding: EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (d['photo_url'] != null && d['photo_url'].toString().isNotEmpty)
                CircleAvatar(
                  backgroundImage: NetworkImage(d['photo_url']),
                  radius: 50,
                )
              else
                CircleAvatar(
                  child: Icon(Icons.person, size: 50),
                  radius: 50,
                ),
              SizedBox(height: 16),
              Text(
                d['name'] ?? driverName,
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 22),
              ),
              SizedBox(height: 20),
              Card(
                child: Column(
                  children: [
                    ListTile(
                      leading: Icon(Icons.person),
                      title: Text("Full Name"),
                      subtitle: Text(d['name'] ?? driverName),
                    ),
                    Divider(height: 1),
                    ListTile(
                      leading: Icon(Icons.phone),
                      title: Text("Registered Phone Number"),
                      subtitle: Text(d['phone'] ?? ''),
                    ),
                    Divider(height: 1),
                    ListTile(
                      leading: Icon(Icons.transgender),
                      title: Text("Gender"),
                      subtitle: Text(d['gender'] ?? 'Not set'),
                    ),
                    Divider(height: 1),
                    ListTile(
                      leading: Icon(Icons.cake),
                      title: Text("Date of Birth"),
                      subtitle: Text(d['dob'] ?? d['date_of_birth'] ?? 'Not set'),
                    ),
                  ],
                ),
              ),
              SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: Text("Close"),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _showIDCard() {
    final d = widget.driver ?? {};
    final name = d['name'] ?? driverName;
    final mobile = d['phone'] ?? '';
    final licenseNo = d['license_no'] ?? d['dl_number'] ?? 'Verified';
    final validity = d['license_validity'] ?? d['license_expiry'] ?? d['dl_validity'] ?? 'Valid Till 2027';
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return Container(
          padding: EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: EdgeInsets.all(20),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [Color(0xFF1565C0), Color(0xFF42A5F5)],
                  ),
                  borderRadius: BorderRadius.circular(16),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black26,
                      blurRadius: 10,
                      offset: Offset(0, 5),
                    ),
                  ],
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Row(
                          children: [
                            Icon(Icons.directions_car, color: Colors.white),
                            SizedBox(width: 8),
                            Text(
                              "UrbanRide",
                              style: TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.bold,
                                fontSize: 20,
                              ),
                            ),
                          ],
                        ),
                        Icon(Icons.verified, color: Colors.white, size: 28),
                      ],
                    ),
                    SizedBox(height: 18),
                    Row(
                      children: [
                        d['photo_url'] != null && d['photo_url'].toString().isNotEmpty
                            ? CircleAvatar(
                                backgroundImage: NetworkImage(d['photo_url']),
                                radius: 32,
                              )
                            : CircleAvatar(
                                child: Icon(Icons.person, size: 36),
                                radius: 32,
                                backgroundColor: Colors.white,
                              ),
                        SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                name,
                                style: TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 18,
                                ),
                              ),
                              Text(
                                "Driver ID: ${d['driver_id'] ?? ''}",
                                style: TextStyle(
                                  color: Colors.white70,
                                  fontSize: 11,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    SizedBox(height: 16),
                    Divider(color: Colors.white30),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              "Mobile Number",
                              style: TextStyle(color: Colors.white70, fontSize: 10),
                            ),
                            Text(
                              mobile,
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 14,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              "License No",
                              style: TextStyle(color: Colors.white70, fontSize: 10),
                            ),
                            Text(
                              licenseNo,
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                    SizedBox(height: 12),
                    Container(
                      padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      decoration: BoxDecoration(
                        color: Colors.white24,
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        "License Validity: $validity",
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    SizedBox(height: 8),
                    Text(
                      "Karnataka Licensed - UrbanRide",
                      style: TextStyle(color: Colors.white70, fontSize: 10),
                    ),
                  ],
                ),
              ),
              SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: Text("Close"),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _deleteAccountDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text("Delete Account?", style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text("This will delete ALL your records from Supabase:"),
            SizedBox(height: 8),
            Text("• Driver profile", style: TextStyle(fontSize: 12)),
            Text("• All documents (SELFIE, DL, RC, etc)", style: TextStyle(fontSize: 12)),
            Text("• Compliance & subscriptions", style: TextStyle(fontSize: 12)),
            SizedBox(height: 12),
            Text("Driver ID: ${widget.driver['driver_id']}", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
            Text("Phone: ${widget.driver['phone']}", style: TextStyle(fontSize: 12)),
            SizedBox(height: 12),
            Text("This cannot be undone!", style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold, fontSize: 12)),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text("Cancel")),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () async {
              Navigator.pop(ctx);
              await _deleteAccount();
            },
            child: Text("DELETE", style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  Future<void> _deleteAccount() async {
    try {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Deleting account..."), backgroundColor: Colors.orange));
      final res = await http.delete(
        Uri.parse("https://saas-backend-avz2.onrender.com/driver/account"),
        headers: {"Authorization": "Bearer ${widget.token}"},
      ).timeout(Duration(seconds: 15));
      print("Delete account status ${res.statusCode} body ${res.body}");
      if (res.statusCode == 200) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Account deleted! Logging out..."), backgroundColor: Colors.green));
        await Future.delayed(Duration(seconds: 1));
        final prefs = await SharedPreferences.getInstance();
        await prefs.clear();
        if (mounted) {
          if (mounted) {
            Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => AuthGate(mainBuilder: (token, driver, logout) => MainTabPage(token: token, driver: driver, onLogout: logout))), (route) => false);
          }
        }
      } else {
        final res2 = await http.delete(
          Uri.parse("https://saas-backend-avz2.onrender.com/driver/account"),
          headers: {"Authorization": "Bearer ${widget.driver['driver_id']}"},
        ).timeout(Duration(seconds: 15));
        if (res2.statusCode == 200) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Account deleted!"), backgroundColor: Colors.green));
          final prefs = await SharedPreferences.getInstance();
          await prefs.clear();
          if (mounted) {
            if (mounted) {
            Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => AuthGate(mainBuilder: (token, driver, logout) => MainTabPage(token: token, driver: driver, onLogout: logout))), (route) => false);
          }
          }
        } else {
          throw Exception("Delete failed ${res.statusCode} ${res.body} / ${res2.statusCode} ${res2.body}");
        }
      }
    } catch (e) {
      print("Delete account error $e");
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Delete failed: $e"), backgroundColor: Colors.red, duration: Duration(seconds: 4)));
    }
  }


  void _showCollectCashDialog(Map<String, dynamic> ride) {
    final fare = ride['fare'] ?? ride['amount'] ?? 55;
    final rideId = ride['ride_id'] ?? ride['id'] ?? '';
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Text("Collect Fare", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text("Ride: $rideId", style: TextStyle(fontSize: 12, color: Colors.black54)),
            SizedBox(height: 12),
            Container(
              padding: EdgeInsets.all(12),
              decoration: BoxDecoration(color: Colors.green.shade50, borderRadius: BorderRadius.circular(8)),
              child: Row(
                children: [
                  Icon(Icons.currency_rupee, color: Colors.green.shade700, size: 28),
                  SizedBox(width: 8),
                  Text("₹${fare.toString()}", style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Colors.green.shade700)),
                ],
              ),
            ),
            SizedBox(height: 16),
            Text("Collect from customer:", style: TextStyle(fontWeight: FontWeight.w600)),
            SizedBox(height: 8),
            Text("• Cash, or", style: TextStyle(fontSize: 13)),
            Text("• UPI to ${ _driverUpiId ?? 'your UPI' }", style: TextStyle(fontSize: 13)),
            SizedBox(height: 8),
            Text("Your QR is in Earnings > UPI QR tab", style: TextStyle(fontSize: 11, color: Colors.black54)),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              _toast("Ride not closed - collect fare first", color: Colors.orange);
            },
            child: Text("Not Collected", style: TextStyle(color: Colors.red)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
            onPressed: () {
              Navigator.pop(ctx);
              _confirmCashCollected(ride);
            },
            child: Text("Collected - Yes", style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmCashCollected(Map<String, dynamic> ride) async {
    try {
      final rideId = ride['ride_id'] ?? ride['id'];
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Fare collected - closing ride..."), backgroundColor: Colors.green));
      // Mark ride as completed with cash collected
      final res = await http.post(
        Uri.parse("$backendUrl/rides/${rideId}/complete"),
        headers: {..._jsonHeaders, 'Authorization': 'Bearer ${widget.token}'},
        body: jsonEncode({'payment_status': 'CASH_COLLECTED', 'fare_collected': true}),
      ).timeout(Duration(seconds: 10));
      print("Collect cash complete status ${res.statusCode} body ${res.body}");
      setState(() {
        _activeRide = null;
        _status = "Online - waiting for rides";
      });
      _toast("₹${ride['fare'] ?? 55} collected - Ride closed!", color: Colors.green, secs: 4);
    } catch(e) {
      print("Collect error $e");
      _toast("Error closing ride: $e", color: Colors.red);
    }
  }

  void _showDocuments() {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => DocumentsPage(driver: widget.driver, token: widget.token),
      ),
    );
  }

  Widget _buildTopDropdown() {
    return Positioned(
      top: 88,
      left: 8,
      child: Material(
        elevation: 12,
        borderRadius: BorderRadius.circular(12),
        shadowColor: Colors.black26,
        child: Container(
          width: 260,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.green.shade50,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
                ),
                child: Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: Colors.green.shade100,
                      child: Icon(Icons.person, color: Colors.green.shade700),
                    ),
                    SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(driverName, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14), maxLines: 1, overflow: TextOverflow.ellipsis),
                          Text(widget.driver['driver_id'] ?? '', style: TextStyle(fontSize: 11, color: Colors.black54)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              ListTile(
                dense: true,
                leading: Icon(Icons.person_outline, size: 22),
                title: Text("Profile Info", style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                subtitle: Text("Photo, Name, Phone, Gender, DOB", style: TextStyle(fontSize: 11)),
                trailing: Icon(Icons.arrow_forward_ios, size: 14),
                onTap: () {
                  setState(() => _showTopDropdown = false);
                  _showProfileInfo();
                },
              ),
              Divider(height: 1),
              ListTile(
                dense: true,
                leading: Icon(Icons.badge, color: Colors.blue, size: 22),
                title: Text("UrbanRide ID Card", style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                subtitle: Text("Name, Mobile, License Validity", style: TextStyle(fontSize: 11)),
                trailing: Icon(Icons.arrow_forward_ios, size: 14),
                onTap: () {
                  setState(() => _showTopDropdown = false);
                  _showIDCard();
                },
              ),
              Divider(height: 1),
              ListTile(
                dense: true,
                leading: Icon(Icons.folder, size: 22),
                title: Text("Documents", style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                subtitle: Text("DL, Aadhaar, RC, Permit, Insurance", style: TextStyle(fontSize: 11)),
                trailing: Icon(Icons.arrow_forward_ios, size: 14),
                onTap: () {
                  setState(() => _showTopDropdown = false);
                  _showDocuments();
                },
              ),
              Divider(height: 1),
              ListTile(
                dense: true,
                leading: Icon(Icons.delete_forever, color: Colors.red, size: 22),
                title: Text("Delete Account", style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14, color: Colors.red)),
                subtitle: Text("Delete all driver records from Supabase", style: TextStyle(fontSize: 11, color: Colors.redAccent)),
                trailing: Icon(Icons.arrow_forward_ios, size: 14, color: Colors.red),
                onTap: () {
                  setState(() => _showTopDropdown = false);
                  _deleteAccountDialog();
                },
              ),
              SizedBox(height: 6),
            ],
          ),
        ),
      ),
    );
  }


    Widget _bigButton(String text, Color color, VoidCallback? onTap, {double flex = 1}) {
    return Expanded(
        flex: (flex * 10).round(),
        child: SizedBox(
            height: 48,
            child: ElevatedButton(
                onPressed: _busy ? null : onTap,
                style: ElevatedButton.styleFrom(
                    backgroundColor: color,
                    disabledBackgroundColor: Colors.grey.shade300,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24))),
                child: _busy && onTap != null
                    ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : FittedBox(child: Text(text, style: TextStyle(color: (_busy || onTap == null) ? Colors.grey.shade600 : Colors.white, fontWeight: FontWeight.bold))))));
  }

  Widget _rideInfoCard() {
    final r = _activeRide!;
    final st = _rideStatus(r);
    final fare = r['fare'];
    return Container(
        padding: EdgeInsets.all(10),
        margin: EdgeInsets.only(bottom: 10),
        decoration: BoxDecoration(color: Colors.green.shade50, borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text("${r['ride_id']}", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14))),
            Container(
                padding: EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: Colors.green, borderRadius: BorderRadius.circular(10)),
                child: Text(st, style: TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold))),
          ]),
          SizedBox(height: 6),
          Row(children: [
            Icon(Icons.person_pin_circle, color: Colors.blue, size: 18),
            SizedBox(width: 4),
            Expanded(child: Text("From: ${_textFor(r, 'from') ?? 'Finding address...'}", maxLines: 1, overflow: TextOverflow.ellipsis)),
          ]),
          SizedBox(height: 2),
          Row(children: [
            Icon(Icons.location_pin, color: Colors.red, size: 18),
            SizedBox(width: 4),
            Expanded(child: Text("To: ${_textFor(r, 'to') ?? 'Finding address...'}", maxLines: 1, overflow: TextOverflow.ellipsis)),
          ]),
          if (st == 'ACCEPTED' || st == 'STARTED' || st == 'ARRIVED' || st == 'COMPLETED')
            Builder(builder: (ctx) {
              final d = _distTo(st == 'ACCEPTED' ? r['from'] : r['to']);
              final label = st == 'ACCEPTED' ? "pickup" : "drop";
              String msg;
              Color c = Colors.blue.shade800;
              if (d == null) {
                msg = "Waiting for GPS...";
              } else if (st == 'ACCEPTED' && !_testMode && d > _arriveMeters) {
                msg = "${_fmtDist(d)} to $label - get within ${_arriveMeters.round()} m to mark ARRIVED";
              } else if (st == 'ACCEPTED') {
                msg = d <= _arriveMeters ? "You are at the pickup" : "${_fmtDist(d)} to $label";
                c = Colors.green.shade800;
              } else {
                msg = "${_fmtDist(d)} to $label";
              }
              return Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(msg + (st == 'ACCEPTED' && _testMode ? "  (test mode)" : ""), style: TextStyle(fontWeight: FontWeight.w600, color: c)));
            }),
          if (r['booked_for_other'] == true)
            Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text("Passenger: ${r['passenger_name'] ?? ''} ${r['passenger_phone'] ?? ''}", style: TextStyle(fontWeight: FontWeight.w600))),
          SizedBox(height: 8),
          FareBreakdownWidget(
            breakdown: r['fare_breakdown'] is Map ? Map<String,dynamic>.from(r['fare_breakdown']) : null,
            totalFare: fare,
            vehicleType: r['vehicle_type'] ?? 'TAXI',
          ),
        ]));
  }

  bool get _popupShowing => _reqDialogOpen && (_rideStatus(_activeRide) == 'REQUESTED' || _rideStatus(_activeRide) == 'SEARCHING');

  void _callRider(String phone) async {
    final uri = Uri.parse("tel:$phone");
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Cannot call $phone")));
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Call failed: $e")));
    }
  }

  void _textRiderDialog(String phone) {
    final quickMessages = [
      "I have reached your location",
      "I am on the way",
      "Too much traffic, will be late by 2 mins",
      "Please come to pickup point",
      "I am waiting at pickup",
    ];
    showModalBottomSheet(
      context: context,
      builder: (ctx) => Container(
        padding: EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text("Quick Messages", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            SizedBox(height: 12),
            ...quickMessages.map((msg) => ListTile(
              dense: true,
              leading: Icon(Icons.message, size: 20, color: Colors.blue),
              title: Text(msg, style: TextStyle(fontSize: 13)),
              onTap: () {
                Navigator.pop(ctx);
                _sendQuickMessage(phone, msg);
              },
            )).toList(),
            Divider(),
            ListTile(
              leading: Icon(Icons.sms, color: Colors.green),
              title: Text("Send Custom SMS", style: TextStyle(fontWeight: FontWeight.bold)),
              onTap: () {
                Navigator.pop(ctx);
                final smsUri = Uri.parse("sms:$phone");
                launchUrl(smsUri);
              },
            ),
            SizedBox(height: 20),
          ],
        ),
      ),
    );
  }

  void _sendQuickMessage(String phone, String message) {
    final smsUri = Uri.parse("sms:$phone?body=${Uri.encodeComponent(message)}");
    launchUrl(smsUri);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Message: $message"), backgroundColor: Colors.blue));
  }

  Widget _actionButtons() {
    final st = _rideStatus(_activeRide);
    if (_activeRide == null) {
      return Row(children: [
        _bigButton("GO ONLINE", Colors.green, _online ? null : _goOnline),
        SizedBox(width: 10),
        _bigButton("GO OFFLINE", Colors.red, _online ? _goOffline : null),
      ]);
    }
    if (st == 'REQUESTED' || st == 'SEARCHING') {
      return Row(children: [
        _bigButton("DECLINE", Colors.red, _decline),
        SizedBox(width: 10),
        _bigButton("ACCEPT", Colors.blue, _accept, flex: 1.5),
      ]);
    }
    if (st == 'ACCEPTED') {
      final passengerPhone = _activeRide!['passenger_phone'] ?? _activeRide!['customer_phone'] ?? '';
      return Column(mainAxisSize: MainAxisSize.min, children: [
        if (passengerPhone.toString().isNotEmpty)
          Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Row(children: [
              Expanded(
                child: OutlinedButton.icon(
                  icon: Icon(Icons.call, size: 18, color: Colors.green),
                  label: Text("Call Rider", style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                  onPressed: () => _callRider(passengerPhone),
                  style: OutlinedButton.styleFrom(padding: EdgeInsets.symmetric(vertical: 8), side: BorderSide(color: Colors.green)),
                ),
              ),
              SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  icon: Icon(Icons.message, size: 18, color: Colors.blue),
                  label: Text("Text Rider", style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                  onPressed: () => _textRiderDialog(passengerPhone),
                  style: OutlinedButton.styleFrom(padding: EdgeInsets.symmetric(vertical: 8), side: BorderSide(color: Colors.blue)),
                ),
              ),
            ]),
          ),
        Row(children: [_bigButton("NAVIGATE TO PICKUP", Colors.blue, () => _navigate(_activeRide!['from']))]),
        SizedBox(height: 8),
        Row(children: [
          _bigButton("CANCEL", Colors.red, _cancelDialog),
          SizedBox(width: 10),
          _bigButton("ARRIVED", Colors.orange, _nearPickup ? () => _updateStatus("ARRIVED") : null, flex: 1.5),
        ]),
      ]);
    }
    if (st == 'ARRIVED') {
      return Row(children: [
        _bigButton("CANCEL", Colors.red, _cancelDialog),
        SizedBox(width: 10),
        _bigButton("ENTER PIN & START", Colors.green, _startWithPin, flex: 1.5),
      ]);
    }
    if (st == 'STARTED') {
      return Column(mainAxisSize: MainAxisSize.min, children: [
        Row(children: [_bigButton("NAVIGATE TO DROP", Colors.blue, () => _navigate(_activeRide!['to']))]),
        SizedBox(height: 8),
        Row(children: [_bigButton("COMPLETE RIDE", Colors.green, () => _updateStatus("COMPLETED"))]),
      ]);
    }
    return Row(children: [
      _bigButton("CANCEL", Colors.red, _cancelDialog),
      SizedBox(width: 10),
      _bigButton("RESET", Colors.grey, () => setState(() {
        _activeRide = null;
        _route = [];
      })),
    ]);
  }

  Widget _buildMapTab() {
    final me = _pos != null ? LatLng(_pos!.latitude, _pos!.longitude) : LatLng(12.9716, 77.5946);
    final cust = _activeRide != null ? _pt(_activeRide!['from']) : null;
    final dest = _activeRide != null ? _pt(_activeRide!['to']) : null;

    return Stack(children: [
      Positioned.fill(
          child: _pos == null
              ? Center(child: CircularProgressIndicator())
              : FlutterMap(
              mapController: _mapCtrl,
              options: MapOptions(center: me, zoom: 14),
              children: [
                TileLayer(urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', userAgentPackageName: 'com.saas.driver_app'),
                if (_route.isNotEmpty) PolylineLayer(polylines: [Polyline(points: _route, color: Colors.blue, strokeWidth: 5)]),
                MarkerLayer(markers: [
                  Marker(point: me, width: 40, height: 40, builder: (ctx) => Icon(Icons.local_taxi, color: Colors.green, size: 35)),
                  if (cust != null) Marker(point: cust, width: 40, height: 40, builder: (ctx) => Icon(Icons.person_pin_circle, color: Colors.blue, size: 35)),
                  if (dest != null) Marker(point: dest, width: 40, height: 40, builder: (ctx) => Icon(Icons.location_pin, color: Colors.red, size: 35))
                ])
              ])),
      Positioned(
          left: 0,
          right: 0,
          bottom: 0,
          child: Container(
              padding: EdgeInsets.fromLTRB(12, 10, 12, 12),
              decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
                  boxShadow: [BoxShadow(color: Colors.black26, blurRadius: 10)]),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Row(children: [
                  Icon(Icons.circle, size: 10, color: _online ? Colors.green : Colors.red),
                  SizedBox(width: 6),
                  Expanded(child: Text(_status, style: TextStyle(fontWeight: FontWeight.bold, color: _online ? Colors.green.shade800 : Colors.red))),
                ]),
                SizedBox(height: 6),
                if (_activeRide != null && !_popupShowing) _rideInfoCard(),
                if (!_popupShowing) _actionButtons(),
              ]))),
    ]);
  }

  static const _darkGreen = Color(0xFF1B5E20);

  String _clock(DateTime t) {
    final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
    return "$h:${t.minute.toString().padLeft(2, '0')} ${t.hour >= 12 ? 'pm' : 'am'}";
  }

  Widget _modeButton(String label, int mode) {
    final sel = _ordMode == mode;
    return Expanded(
        child: GestureDetector(
            onTap: () {
              setState(() {
                _ordMode = mode;
                _ordIdx = -1;
              });
              _scrollToChip(_periods().length - 1);
            },
            child: Container(
                margin: EdgeInsets.symmetric(horizontal: 4),
                padding: EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(color: sel ? Colors.green : Colors.grey.shade200, borderRadius: BorderRadius.circular(8)),
                child: Center(child: Text(label, style: TextStyle(fontWeight: FontWeight.w600, color: sel ? Colors.white : Colors.black87))))));
  }

  Widget _arrow(IconData icon, VoidCallback? onTap) {
    return GestureDetector(
        onTap: onTap,
        child: Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: Colors.white, shape: BoxShape.circle, boxShadow: [BoxShadow(color: Colors.black26, blurRadius: 4)]),
            child: Icon(icon, size: 20, color: onTap == null ? Colors.grey : Colors.blue.shade800)));
  }

  Widget _pill(String label, String tab) {
    final sel = _ordTab == tab;
    return GestureDetector(
        onTap: () => setState(() => _ordTab = tab),
        child: Container(
            margin: EdgeInsets.only(right: 10),
            padding: EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: BoxDecoration(color: sel ? Colors.green.shade100 : Colors.grey.shade200, borderRadius: BorderRadius.circular(8)),
            child: Text(label, style: TextStyle(fontWeight: sel ? FontWeight.bold : FontWeight.w500, color: sel ? Colors.black : Colors.black54))));
  }

  Widget _orderCard(Map<String, dynamic> o) {
    final done = o['status'] == 'COMPLETED';
    final t = o['time'] as DateTime?;
    final id = '${o['ride_id']}';
    final short = id.length > 5 ? id.substring(id.length - 5) : id;
    return Container(
        margin: EdgeInsets.fromLTRB(16, 5, 16, 5),
        padding: EdgeInsets.all(14),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: Colors.grey.shade300)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
                child: Text("Ride #$short${t != null ? '  •  ${_clock(t)}' : ''}",
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
            SizedBox(width: 10),
            Text("₹${_money(o['fare'])}",
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: done ? Colors.green.shade700 : Colors.grey)),
            SizedBox(width: 4),
            Icon(done ? Icons.check_circle : Icons.cancel, size: 16, color: done ? Colors.green : Colors.red),
          ]),
          Divider(height: 18),
          Row(children: [
            Icon(Icons.circle, size: 10, color: Colors.green),
            SizedBox(width: 10),
            Expanded(child: Text("${o['from'] ?? (o['fromPt'] != null ? 'Locating address...' : 'Pickup location')}", maxLines: 1, overflow: TextOverflow.ellipsis)),
          ]),
          SizedBox(height: 8),
          Row(children: [
            Icon(Icons.circle, size: 10, color: Colors.red),
            SizedBox(width: 10),
            Expanded(child: Text("${o['to'] ?? (o['toPt'] != null ? 'Locating address...' : 'Drop location')}", maxLines: 1, overflow: TextOverflow.ellipsis)),
          ]),
          if (o['fare_breakdown'] != null) ...[
            SizedBox(height: 8),
            FareBreakdownWidget(
              breakdown: o['fare_breakdown'] is Map ? Map<String,dynamic>.from(o['fare_breakdown']) : null,
              totalFare: o['fare'],
            ),
          ],
          if (!done && '${o['reason']}'.isNotEmpty)
            Padding(padding: EdgeInsets.only(top: 8), child: Text("Reason: ${o['reason']}", style: TextStyle(fontSize: 12, color: Colors.red.shade700))),
        ]));
  }

  Widget _subscriptionCard(_Period p, num earned) {
    if (_sub['enabled'] != true) return SizedBox.shrink();
    num fee = 0;
    for (final c in (_sub['charges'] as List? ?? [])) {
      final d = DateTime.tryParse('${c['charge_date']}');
      if (d == null || '${c['status']}' == 'WAIVED') continue;
      if (!d.isBefore(p.start) && d.isBefore(p.end)) fee += num.tryParse('${c['total_amount']}') ?? 0;
    }
    final due = num.tryParse('${_sub['net_due']}') ?? 0;
    final credit = num.tryParse('${_sub['credit']}') ?? 0;
    final freeLeft = (_sub['free_days_left'] as num?)?.toInt() ?? 0;
    final daily = _sub['daily_total'];
    final pay = '${_sub['pay_instructions'] ?? ''}';
    Widget row(String l, String v, {bool bold = false, Color? color}) => Padding(
        padding: EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          Expanded(child: Text(l, style: TextStyle(fontSize: 13, fontWeight: bold ? FontWeight.bold : FontWeight.normal))),
          Text(v, style: TextStyle(fontSize: 13, fontWeight: bold ? FontWeight.bold : FontWeight.w600, color: color)),
        ]));
    return Container(
        margin: EdgeInsets.fromLTRB(16, 0, 16, 8),
        padding: EdgeInsets.all(12),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: Colors.grey.shade300)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          row("Ride fares (you keep 100%)", "₹${_money(earned)}", color: Colors.green.shade800),
          row("Platform fee", "-₹${_money(fee)}", color: Colors.red.shade700),
          Divider(height: 10),
          row("Net earnings", "₹${_money(earned - fee)}", bold: true),
          SizedBox(height: 6),
          Text(
              freeLeft > 0
                  ? "Free trial: $freeLeft day${freeLeft == 1 ? '' : 's'} left. After that the platform fee is ₹${_money(daily ?? 0)} per day you go online (GST included)."
                  : "Platform fee: ₹${_money(daily ?? 0)} per day you go online (GST included).",
              style: TextStyle(fontSize: 11, color: Colors.black54)),
          if (due > 0)
            Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text("Dues to pay: ₹${_money(due)}${pay.isNotEmpty ? '\n$pay' : ''}", style: TextStyle(fontSize: 12, color: Colors.red.shade800, fontWeight: FontWeight.w600))),
          if (due <= 0 && freeLeft == 0) Padding(padding: EdgeInsets.only(top: 4), child: Text("No dues${credit > 0 ? ' · Credit ₹${_money(credit)}' : ''}", style: TextStyle(fontSize: 12, color: Colors.green.shade800))),
        ]));
  }

  Widget _buildOldEarningsContent() {
    final ps = _periods();
    final sel = _ordIdx < 0 ? ps.length - 1 : _ordIdx.clamp(0, ps.length - 1).toInt();
    final p = ps[sel];
    final inPeriod = _orders.where((o) {
      final t = o['time'] as DateTime?;
      return t != null && !t.isBefore(p.start) && t.isBefore(p.end);
    }).toList();
    final doneList = inPeriod.where((o) => o['status'] == 'COMPLETED').toList();
    num earned = 0;
    for (final o in doneList) earned += (o['fare'] as num);
    final cancelledList = inPeriod.where((o) => o['status'] == 'CANCELLED').toList();
    num lost = 0;
    for (final o in cancelledList) lost += (o['fare'] as num);
    final showCancelled = _ordTab == 'CANCELLED';
    final shown = inPeriod.where((o) => o['status'] == _ordTab).toList();

    void pick(int i) {
      setState(() => _ordIdx = i);
      _scrollToChip(i);
    }

    final rows = <Widget>[];
    String lastDay = "";
    for (final o in shown) {
      final t = o['time'] as DateTime;
      final day = "${t.day.toString().padLeft(2, '0')} ${_fullMonths[t.month - 1]}, ${t.year}";
      if (day != lastDay) {
        lastDay = day;
        rows.add(Padding(
            padding: EdgeInsets.fromLTRB(18, 12, 18, 4),
            child: Text(day, style: TextStyle(fontWeight: FontWeight.bold, color: Colors.blue.shade900))));
      }
      rows.add(_orderCard(o));
    }

    return Column(children: [
      Container(
          color: Colors.white,
          padding: EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Row(children: [_modeButton("Day", 0), _modeButton("Week", 1), _modeButton("Month", 2)])),
      Padding(
          padding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
          child: Row(children: [
            _arrow(Icons.arrow_back, sel > 0 ? () => pick(sel - 1) : null),
            Expanded(
                child: SizedBox(
                    height: 54,
                    child: ListView.builder(
                        key: ValueKey(_ordMode),
                        controller: _chipCtrl,
                        scrollDirection: Axis.horizontal,
                        itemCount: ps.length,
                        itemBuilder: (c, i) {
                          final on = i == sel;
                          return GestureDetector(
                              onTap: () => pick(i),
                              child: Container(
                                  width: _chipW,
                                  margin: EdgeInsets.symmetric(horizontal: 4),
                                  decoration: BoxDecoration(color: on ? _darkGreen : Colors.grey.shade200, borderRadius: BorderRadius.circular(10)),
                                  child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                                    Text(ps[i].l1, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: on ? Colors.white : Colors.black87)),
                                    Text(ps[i].l2, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: on ? Colors.white : Colors.black87)),
                                  ])));
                        }))),
            _arrow(Icons.arrow_forward, sel < ps.length - 1 ? () => pick(sel + 1) : null),
          ])),
      Container(
          margin: EdgeInsets.fromLTRB(16, 4, 16, 8),
          padding: EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: Colors.grey.shade300)),
          child: IntrinsicHeight(
              child: Row(children: [
                Expanded(
                    child: Column(children: [
                      Text("${showCancelled ? cancelledList.length : doneList.length}", style: TextStyle(fontSize: 30, fontWeight: FontWeight.bold, color: Colors.black87)),
                      Text(showCancelled ? "Cancelled Orders" : "Completed Orders", style: TextStyle(fontSize: 12, color: Colors.black54)),
                    ])),
                VerticalDivider(width: 1, thickness: 1),
                Expanded(
                    child: Column(children: [
                      FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Text("₹${_money(showCancelled ? lost : earned)}",
                              style: TextStyle(fontSize: 30, fontWeight: FontWeight.bold, color: showCancelled ? Colors.red.shade700 : Colors.green.shade800))),
                      Text(showCancelled ? "Lost Earnings" : "Order Earnings", style: TextStyle(fontSize: 12, color: Colors.black54)),
                    ])),
              ]))),
      // _subscriptionCard removed to fix 68px overflow
      SizedBox(height:4),
      Padding(
          padding: EdgeInsets.fromLTRB(18, 6, 18, 8),
          child: Align(alignment: Alignment.centerLeft, child: Text("Order History", style: TextStyle(fontSize: 16, color: Colors.black87)))),
      Padding(
          padding: EdgeInsets.symmetric(horizontal: 18),
          child: Row(children: [_pill("Completed", 'COMPLETED'), _pill("Cancelled", 'CANCELLED')])),
      Expanded(
          child: shown.isEmpty
              ? Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.receipt_long, size: 72, color: Colors.grey.shade300),
                SizedBox(height: 12),
                Text(_ordTab == 'COMPLETED' ? "You have not completed any orders" : "You have no cancelled orders",
                    style: TextStyle(fontSize: 15, color: Colors.black54)),
              ]))
              : ListView(padding: EdgeInsets.only(bottom: 16), children: rows)),
    ]);
  }


Widget _buildEarningsTab(){
  return DefaultTabController(
    length: 3,
    child: Column(
      children: [
        Container(color:Colors.white, child:TabBar(labelColor:Colors.green.shade800, unselectedLabelColor:Colors.black54, indicatorColor:Colors.green.shade700, indicatorWeight:3, tabs:[Tab(icon:Icon(Icons.show_chart, size:18), text:"Earnings"), Tab(icon:Icon(Icons.account_balance_wallet, size:18), text:"Wallet"), Tab(icon:Icon(Icons.qr_code, size:18), text:"UPI QR")])),
        Expanded(child:TabBarView(children:[_buildOldEarningsContent(), _walletTab(), _buildUpiQrTab()])),
      ],
    ),
  );
}




  
  // ===== UPI & WALLET =====
  Future<void> _loadUpiId() async {
    try{
      final res = await http.get(Uri.parse("$backendUrl/driver/profile"), headers:{..._jsonHeaders, 'Authorization':'Bearer ${widget.token}'});
      if(res.statusCode==200){
        final d=jsonDecode(res.body);
        final upi = d['driver']?['upi_id'] ?? d['upi_id'];
        if(upi!=null && upi.toString().isNotEmpty){
          setState(()=>_driverUpiId=upi.toString());
          _upiCtrl.text=upi.toString();
          await _generateQr();
        }
      }
    }catch(e){}
    try{
      // prefs removed
    }catch(e){}
  }

  Future<void> _saveUpiId() async {
    final upi=_upiCtrl.text.trim();
    if(upi.isEmpty || !upi.contains('@')){ _toast("Enter valid UPI ID e.g. rajesh@okaxis"); return; }
    setState(()=>_upiSaving=true);
    try{
      final res = await http.post(Uri.parse("$backendUrl/driver/upi"), headers:{..._jsonHeaders, 'Authorization':'Bearer ${widget.token}'}, body:jsonEncode({"upi_id":upi}));
      if(res.statusCode==200){
        setState(()=>_driverUpiId=upi);
        await _generateQr();
        _toast("UPI QR Saved - Direct to Bank");
      }else{
        _toast("Save failed ${res.statusCode}");
      }
    }catch(e){ _toast("Error $e"); }
    setState(()=>_upiSaving=false);
  }

  Future<void> _generateQr() async {
    if(_driverUpiId==null || _driverUpiId!.isEmpty) return;
    final upi=_driverUpiId!.trim();
    // Proper UPI link that GPay can scan - with pn and cu
    final upiLink="upi://pay?pa=$upi&pn=UrbanRide%20Driver&cu=INR";
    print("Generated UPI QR: $upiLink");
    setState(()=>_qrDataUrl=upiLink);
  }

  Future<void> _generateFareQr(double fare) async {
    if(_driverUpiId==null || _driverUpiId!.isEmpty) return;
    final upi=_driverUpiId!.trim();
    final upiLink="upi://pay?pa=$upi&pn=UrbanRide%20Driver&am=${fare.toStringAsFixed(0)}&cu=INR&tn=UrbanRide%20Fare";
    setState(()=>_qrDataUrl=upiLink);
  }

  Future<void> _loadWallet() async {
    if (_walletLoading) return;
    if (mounted) setState(()=>_walletLoading=true);
    try{
      final res = await http.get(Uri.parse("$backendUrl/driver/wallet"), headers:{..._jsonHeaders, 'Authorization':'Bearer ${widget.token}'});
      if(res.statusCode==200){
        final d=jsonDecode(res.body);
        setState((){
          _wallet=d;
          _walletTxns=d['transactions']??[];
        });
      }
    }catch(e){}
    setState(()=>_walletLoading=false);
  }

  Widget _upiSetupCard(){
    return Container(
      padding:EdgeInsets.all(14),
      decoration:BoxDecoration(color:Colors.white, borderRadius:BorderRadius.circular(12), border:Border.all(color:Colors.green.shade200)),
      child:Column(
        crossAxisAlignment:CrossAxisAlignment.start,
        children:[
          Row(children:[Icon(Icons.qr_code, color:Colors.green.shade700), SizedBox(width:8), Text("UPI QR - Direct to Your Bank", style:TextStyle(fontWeight:FontWeight.bold, fontSize:15))]),
          SizedBox(height:6),
          Text("Ride fare goes direct to your bank, zero commission. Set your UPI ID once.", style:TextStyle(fontSize:11, color:Colors.black54)),
          SizedBox(height:10),
          Row(children:[
            Expanded(child:TextField(controller:_upiCtrl, decoration:InputDecoration(hintText:"yourname@okaxis", border:OutlineInputBorder(), contentPadding:EdgeInsets.symmetric(horizontal:10, vertical:10)))),
            SizedBox(width:8),
            ElevatedButton(onPressed:_upiSaving?null: _saveUpiId, child:Text(_upiSaving?"...":"Save"), style:ElevatedButton.styleFrom(backgroundColor:Colors.green.shade700, foregroundColor:Colors.white)),
          ]),
          if(_driverUpiId!=null && _driverUpiId!.isNotEmpty) Padding(
            padding:EdgeInsets.only(top:10),
            child:Row(children:[
              Container(width:80, height:80, decoration:BoxDecoration(border:Border.all(color:Colors.grey.shade300), borderRadius:BorderRadius.circular(8)), child:Icon(Icons.qr_code_2, size:50, color:Colors.black87)),
              SizedBox(width:10),
              Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start, children:[Text("Your QR Active", style:TextStyle(color:Colors.green.shade700, fontWeight:FontWeight.bold, fontSize:13)), Text("UPI: $_driverUpiId", style:TextStyle(fontSize:12)), Text("Customers will scan this at trip end", style:TextStyle(fontSize:10, color:Colors.black54)), Text("₹100 test QR", style:TextStyle(fontSize:10, color:Colors.black45))])),
            ]),
          ),
        ],
      ),
    );
  }

  Widget _buildUpiQrTab(){
    if(_driverUpiId==null) Future.microtask(()=>_loadUpiId());
    return ListView(
      padding:EdgeInsets.all(12),
      children:[
        _upiSetupCard(),
        SizedBox(height:12),
        Container(padding:EdgeInsets.all(12), decoration:BoxDecoration(color:Colors.green.shade50, borderRadius:BorderRadius.circular(10)), child:Text("Customer scans at trip end. Money credits to your bank instantly", style:TextStyle(fontSize:12, color:Colors.green.shade800))),
      ],
    );
  }

  Widget _walletTab(){
    if(_driverUpiId==null) Future.microtask(()=>_loadUpiId());
    if(_wallet==null && !_walletLoading) Future.microtask(()=>_loadWallet());
    final bal=_wallet?['balance']??0;
    final totalEarn=_wallet?['total_earnings']??0;
    final totalRides=_wallet?['total_rides']??0;
    final due=_wallet?['net_due']??0;
    final plan=_wallet?['current_plan']?.toString()??'None';
    final expires=_wallet?['plan_expires_at']?.toString();
    return Padding(
      padding: EdgeInsets.all(12),
      child: Column(
        children: [
          Container(
            padding: EdgeInsets.all(14),
            decoration: BoxDecoration(color:Colors.white, borderRadius:BorderRadius.circular(12), border:Border.all(color:Colors.grey.shade300)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children:[Icon(Icons.account_balance_wallet, color:Colors.green.shade700), SizedBox(width:8), Text("Wallet", style:TextStyle(fontWeight:FontWeight.bold, fontSize:16)), Spacer(), _walletLoading?SizedBox(width:16, height:16, child:CircularProgressIndicator(strokeWidth:2)):IconButton(icon:Icon(Icons.refresh, size:20), onPressed:_loadWallet, padding:EdgeInsets.zero, constraints:BoxConstraints())]),
                SizedBox(height:12),
                Row(children:[Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start, children:[Text("Available Balance", style:TextStyle(fontSize:11, color:Colors.black54)), SizedBox(height:4), Text("₹$bal", style:TextStyle(fontSize:26, fontWeight:FontWeight.bold))])), Container(width:1, height:40, color:Colors.grey.shade300), SizedBox(width:12), Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start, children:[Text("Total Earnings", style:TextStyle(fontSize:11, color:Colors.black54)), SizedBox(height:2), Text("₹$totalEarn", style:TextStyle(fontSize:20, fontWeight:FontWeight.bold, color:Colors.green.shade700)), Text("$totalRides rides", style:TextStyle(fontSize:11, color:Colors.black54))]))]),
                if(expires!=null && expires!='null' && expires.isNotEmpty) Padding(padding:EdgeInsets.only(top:8), child:Text("Expires: ${expires.length>=10?expires.substring(0,10):expires}", style:TextStyle(fontSize:11, color:Colors.black54))),
                if(due is num && due>0) Padding(padding:EdgeInsets.only(top:4), child:Text("Due: ₹$due", style:TextStyle(color:Colors.red, fontSize:12, fontWeight:FontWeight.bold))),
                SizedBox(height:12),
                SizedBox(width:double.infinity, child:ElevatedButton(onPressed:(){ showDialog(context:context, builder:(_)=>_subscriptionDialog()); }, child:Text(plan=='None' || plan=='null' ? "View Plans - ₹25/day" : "Renew / Plans - $plan"), style:ElevatedButton.styleFrom(backgroundColor:Colors.green.shade700, foregroundColor:Colors.white, padding:EdgeInsets.symmetric(vertical:14)))),
                SizedBox(height:8),
                Text("Zero commission - you keep 100% fare. UPI QR in UPI tab.", style:TextStyle(fontSize:10, color:Colors.black54)),
              ],
            ),
          ),
          SizedBox(height:12),
          Row(children:[Text("Recent Transactions", style:TextStyle(fontWeight:FontWeight.bold, fontSize:13)), Spacer(), Text("${_walletTxns.length} txns", style:TextStyle(fontSize:11, color:Colors.black54))]),
          SizedBox(height:8),
          Expanded(
            child: _walletTxns.isEmpty
              ? Container(padding:EdgeInsets.all(20), decoration:BoxDecoration(color:Colors.white, borderRadius:BorderRadius.circular(10), border:Border.all(color:Colors.grey.shade200)), child:Center(child:Text("No transactions yet", style:TextStyle(color:Colors.black54))))
              : ListView.builder(
                  itemCount: _walletTxns.length>5 ? 5 : _walletTxns.length,
                  itemBuilder: (c,i){
                    final t=_walletTxns[i]; final amt=t['amount']??0; final type=(t['type']??'').toString(); final isCredit=type=='EARNING' || (amt is num && amt>0);
                    return Container(margin:EdgeInsets.only(bottom:6), padding:EdgeInsets.symmetric(horizontal:10, vertical:8), decoration:BoxDecoration(color:Colors.white, borderRadius:BorderRadius.circular(8), border:Border.all(color:Colors.grey.shade200)), child:Row(children:[Icon(isCredit?Icons.arrow_downward:Icons.arrow_upward, size:14, color:isCredit?Colors.green:Colors.red), SizedBox(width:8), Expanded(child:Text(t['description']??type, style:TextStyle(fontSize:12))), Text("₹$amt", style:TextStyle(fontWeight:FontWeight.bold, fontSize:12, color:isCredit?Colors.green.shade700:Colors.red))]));
                  },
                ),
          ),
        ],
      ),
    );
  }

  Widget _subscriptionDialog(){
    return AlertDialog(
      title:Text("Subscription Plans"),
      content:Container(
        width: double.maxFinite,
        child: SingleChildScrollView(child:Column(mainAxisSize:MainAxisSize.min, children:[
          _planTile("AUTO_DAILY","Auto Daily","₹25","24 hours unlimited rides"),
          _planTile("AUTO_WEEKLY","Auto Weekly","₹150","7 days unlimited rides - Save ₹25"),
          _planTile("AUTO_MONTHLY","Auto Monthly","₹599","30 days unlimited rides - Best value"),
          _planTile("TAXI_DAILY","Taxi Daily","₹35","24 hours unlimited rides"),
          _planTile("TAXI_WEEKLY","Taxi Weekly","₹199","7 days unlimited rides - Save ₹46"),
          _planTile("TAXI_MONTHLY","Taxi Monthly","₹799","30 days unlimited rides - Best value"),
          SizedBox(height:8),
          Text("Zero commission - you keep 100% fare", style:TextStyle(fontSize:10, color:Colors.black54)),
          Text("Per ride ₹5 option coming soon", style:TextStyle(fontSize:9, color:Colors.grey)),
        ])),
      ),
      actions:[TextButton(onPressed:()=>Navigator.pop(context), child:Text("Close"))],
    );
  }

  Widget _planTile(String id, String title, String price, String desc){
    final priceMap = {"AUTO_DAILY":25,"AUTO_WEEKLY":150,"AUTO_MONTHLY":599,"TAXI_DAILY":35,"TAXI_WEEKLY":199,"TAXI_MONTHLY":799,"DAILY_AUTO":25,"DAILY_TAXI":35};
    final planMap = {"AUTO_DAILY":"DAILY_AUTO","AUTO_WEEKLY":"DAILY_AUTO","AUTO_MONTHLY":"MONTHLY_AUTO","TAXI_DAILY":"DAILY_TAXI","TAXI_WEEKLY":"DAILY_TAXI","TAXI_MONTHLY":"MONTHLY_TAXI"};
    return Container(
      margin:EdgeInsets.symmetric(vertical:6),
      padding:EdgeInsets.all(12),
      decoration:BoxDecoration(border:Border.all(color:Colors.grey.shade300), borderRadius:BorderRadius.circular(10)),
      child:Row(children:[
        Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start, children:[Text(title, style:TextStyle(fontWeight:FontWeight.bold)), Text(price, style:TextStyle(color:Colors.green.shade700, fontWeight:FontWeight.bold)), Text(desc, style:TextStyle(fontSize:11, color:Colors.black54))])),
        ElevatedButton(onPressed:() async {
          Navigator.pop(context);
          final amt = priceMap[id] ?? 25;
          final serverPlan = planMap[id] ?? "DAILY_AUTO";
          final rid = "sub_${DateTime.now().millisecondsSinceEpoch}";
          _toast("Creating order ₹$amt...");
          try{
            final res = await http.post(Uri.parse("$backendUrl/rider/payment/order"), headers:{..._jsonHeaders, 'Authorization':'Bearer ${widget.token}'}, body:jsonEncode({"ride_id":rid, "amount":amt}));
            if(res.statusCode!=200){ _toast("Order failed ${res.statusCode}"); return; }
            final o=jsonDecode(res.body); final orderId=o['order_id']??o['id']; final keyId=o['key_id']??'rzp_live_xxx';
            _toast("Opening Razorpay...");
            final _rzp = Razorpay();
            _rzp.on(Razorpay.EVENT_PAYMENT_SUCCESS, (PaymentSuccessResponse resp) async {
              _toast("Payment success");
              try{
                final ver = await http.post(Uri.parse("$backendUrl/driver/subscription/razorpay/verify"), headers:{..._jsonHeaders, 'Authorization':'Bearer ${widget.token}'}, body:jsonEncode({"razorpay_order_id":resp.orderId, "razorpay_payment_id":resp.paymentId, "razorpay_signature":resp.signature, "plan_id":serverPlan}));
                if(ver.statusCode==200){ _toast("Plan Activated LIVE"); _loadWallet(); } else { final act = await http.post(Uri.parse("$backendUrl/driver/subscription/activate"), headers:{..._jsonHeaders, 'Authorization':'Bearer ${widget.token}'}, body:jsonEncode({"plan_id":serverPlan, "payment_id":resp.paymentId, "amount":amt})); if(act.statusCode==200){ _toast("Plan Activated"); _loadWallet(); } }
              }catch(e){ _toast("Verify $e"); }
              _rzp.clear();
            });
            _rzp.on(Razorpay.EVENT_PAYMENT_ERROR, (PaymentFailureResponse resp){ _toast("Payment failed"); _rzp.clear(); });
            _rzp.on(Razorpay.EVENT_EXTERNAL_WALLET, (ExternalWalletResponse resp){ _rzp.clear(); });
            _rzp.open({'key': keyId, 'amount': amt*100, 'name': 'UrbanRide', 'description': title, 'order_id': orderId});
          }catch(e){ _toast("Error $e"); }
        }, child:Text("Buy")),
      ]),
    );
  }



  void _confirmLogout() {
    showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text("Log out?"),
          content: Text(_activeRide != null ? "You have a ride in progress. Finish or cancel it first." : "You will go offline and stop receiving rides."),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: Text("Stay")),
            if (_activeRide == null)
              ElevatedButton(
                  onPressed: () {
                    Navigator.pop(ctx);
                    _goOffline();
                    widget.onLogout();
                  },
                  child: Text("Log out")),
          ],
        ));
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Scaffold(
      appBar: AppBar(
        leading: IconButton(icon: Icon(Icons.menu), onPressed: _showProfileSheet),
          title: Row(children: [
            Flexible(child: Text(driverName, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 16))),
            SizedBox(width: 4),
            Icon(Icons.verified, size: 18, color: Colors.lightBlueAccent),
            SizedBox(width: 8),
            Text(_online ? '● ONLINE' : '○ OFFLINE', style: TextStyle(fontSize: 13)),
          ]),
          backgroundColor: _online ? Colors.green : Colors.grey.shade700,
          foregroundColor: Colors.white,
          actions: [
            IconButton(
                tooltip: _soundOn ? "Ringer on" : "Ringer off",
                icon: Icon(_soundOn ? Icons.volume_up : Icons.volume_off, size: 28),
                onPressed: _toggleSound),
            PopupMenuButton<String>(
                onSelected: (v) {
                  if (v == 'logout') _confirmLogout();
                },
                itemBuilder: (_) => [PopupMenuItem(value: 'logout', child: Text("Log out"))]),
          ]),
      body: [
        _buildMapTab(),
        _buildEarningsTab(),
      ][_currentIndex.clamp(0,1)],
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentIndex,
        onTap: (i) {
          setState(() => _currentIndex = i);
          if (i != 0) {
            _loadHistory();
            _scrollToChip(_ordIdx < 0 ? _periods().length - 1 : _ordIdx);
          }
        },
        items: [
          BottomNavigationBarItem(icon: Icon(Icons.map), label: "Map"),
          BottomNavigationBarItem(icon: Icon(Icons.currency_rupee), label: "Earnings"),
        ],
      ),
        ),
        if (_showTopDropdown)
          Positioned.fill(
            child: GestureDetector(
              onTap: _hideDropdown,
              child: Container(color: Colors.black12),
            ),
          ),
        if (_showTopDropdown) _buildTopDropdown(),
      ],
    );
  }
}


class DocumentsPage extends StatefulWidget {
  final Map<String, dynamic> driver;
  final String token;
  DocumentsPage({required this.driver, required this.token});
  @override
  _DocumentsPageState createState() => _DocumentsPageState();
}

class _DocumentsPageState extends State<DocumentsPage> {
  Map<String, String?> docUrls = {};
  Map<String, String> docStatus = {};
  bool loading = true;
  final List<Map<String, dynamic>> allDocs = [
    {'type': 'SELFIE', 'title': 'Selfie', 'subtitle': 'Profile Photo', 'icon': Icons.person, 'color': Colors.blue},
    {'type': 'DL', 'title': 'Driving License', 'subtitle': 'DL Front & Back', 'icon': Icons.credit_card, 'color': Colors.blue},
    {'type': 'AADHAAR', 'title': 'Aadhaar Card', 'subtitle': 'Aadhaar Front & Back', 'icon': Icons.badge, 'color': Colors.orange},
    {'type': 'RC', 'title': 'RC Book', 'subtitle': 'Vehicle RC', 'icon': Icons.directions_car, 'color': Colors.green},
    {'type': 'PERMIT', 'title': 'Vehicle Permit', 'subtitle': 'Karnataka Permit', 'icon': Icons.description, 'color': Colors.teal},
    {'type': 'INSURANCE', 'title': 'Insurance', 'subtitle': 'Vehicle Insurance', 'icon': Icons.shield, 'color': Colors.purple},
    {'type': 'POLICE', 'title': 'Police Verification', 'subtitle': 'Police Clearance', 'icon': Icons.verified_user, 'color': Colors.indigo},
  ];

  @override
  void initState() {
    super.initState();
    _fetchDocs();
  }

  Future<void> _fetchDocs() async {
    setState(() => loading = true);
    try {
      final meRes = await http.get(
        Uri.parse("https://saas-backend-avz2.onrender.com/driver/me"),
        headers: {"Authorization": "Bearer ${widget.token}"},
      ).timeout(Duration(seconds: 15));
      if (meRes.statusCode == 200) {
        final meData = json.decode(meRes.body);
        final List docs = meData['documents'] ?? [];
        print("ME docs: $docs");
        docUrls.clear();
        docStatus.clear();
        for (var d in docs) {
          final type = (d['doc_type'] ?? '').toString().toUpperCase();
          final url = d['url'] ?? '';
          final status = d['status'] ?? 'APPROVED';
          if (type.isNotEmpty && url.toString().isNotEmpty) {
            docUrls[type] = url.toString() + "${url.toString().contains("?") ? "&" : "?"}t=${DateTime.now().millisecondsSinceEpoch}";
            docStatus[type] = (status == 'PENDING' ? 'APPROVED' : status);
          }
        }
        // Also try individual url endpoints for missing
        for (var docDef in allDocs) {
          final type = docDef['type'];
          if (!docUrls.containsKey(type)) {
            try {
              final urlRes = await http.get(
                Uri.parse("https://saas-backend-avz2.onrender.com/driver/docs/$type/url"),
                headers: {"Authorization": "Bearer ${widget.token}"},
              ).timeout(Duration(seconds: 6));
              if (urlRes.statusCode == 200) {
                final urlData = json.decode(urlRes.body);
                docUrls[type] = urlData['url'];
                docStatus[type] = urlData['status'] ?? 'APPROVED';
              }
            } catch (e) {
              print("url fetch $type failed $e");
            }
          }
        }
      }
    } catch (e) {
      print("fetchDocs error $e");
    }
    // Final fallback to driver map urls
    docUrls['SELFIE'] ??= widget.driver['selfie_url'] ?? widget.driver['photo_url'] ?? widget.driver['profile_photo'];
    docUrls['DL'] ??= widget.driver['driving_license_url'] ?? widget.driver['dl_url'] ?? widget.driver['license_url'];
    docUrls['AADHAAR'] ??= widget.driver['aadhaar_url'];
    docUrls['RC'] ??= widget.driver['rc_url'] ?? widget.driver['rc_book_url'];
    docUrls['PERMIT'] ??= widget.driver['permit_url'] ?? widget.driver['vehicle_permit_url'];
    docUrls['INSURANCE'] ??= widget.driver['insurance_url'];
    docUrls['POLICE'] ??= widget.driver['police_verification_url'] ?? widget.driver['police_url'];
    
    // Set status to APPROVED if url exists but no status
    docUrls.forEach((k,v){
      if (v != null && v.isNotEmpty) {
        docStatus[k] ??= 'APPROVED';
      }
    });
    
    setState(() => loading = false);
  }

  void _viewDoc(String title, String? url, String status) {
    if (url == null || url.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("$title not uploaded yet - Status: $status")));
      return;
    }
    showDialog(
      context: context,
      builder: (ctx) {
        return Dialog(
          insetPadding: EdgeInsets.all(12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppBar(
                title: Text(title, style: TextStyle(fontSize: 16)),
                automaticallyImplyLeading: false,
                actions: [IconButton(icon: Icon(Icons.close), onPressed: () => Navigator.pop(ctx))],
              ),
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    children: [
                      url.startsWith("http")
                          ? Image.network(
                              url,
                              fit: BoxFit.contain,
                              loadingBuilder: (c, child, progress) {
                                if (progress == null) return child;
                                return Padding(padding: EdgeInsets.all(30), child: CircularProgressIndicator());
                              },
                              errorBuilder: (c, e, s) {
                                return Padding(padding: EdgeInsets.all(20), child: Column(children: [Icon(Icons.broken_image, size: 60, color: Colors.grey), SizedBox(height: 10), Text("Image not available"), Text(url, style: TextStyle(fontSize: 8))]));
                              },
                            )
                          : Padding(padding: EdgeInsets.all(20), child: Text(url)),
                      Padding(padding: EdgeInsets.all(8), child: Text("Status: $status", style: TextStyle(fontSize: 12, color: Colors.green.shade700, fontWeight: FontWeight.bold))),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: EdgeInsets.all(12),
                child: Column(
                  children: [
                    SizedBox(width: double.infinity, child: ElevatedButton.icon(icon: Icon(Icons.photo_library), label: Text("Re-upload from Gallery"), onPressed: () { Navigator.pop(ctx); _reuploadDoc(title); })),
                    SizedBox(height: 6),
                    SizedBox(width: double.infinity, child: OutlinedButton(onPressed: () => Navigator.pop(ctx), child: Text("Return"))),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

    Future<void> _reuploadDoc(String title) async {
    String type = title.toUpperCase();
    if (title.toLowerCase().contains("selfie")) type = "SELFIE";
    else if (title.toLowerCase().contains("driving")) type = "DL";
    else if (title.toLowerCase().contains("aadhaar")) type = "AADHAAR";
    else if (title.toLowerCase().contains("rc book")) type = "RC";
    else if (title.toLowerCase().contains("rc")) type = "RC";
    else if (title.toLowerCase().contains("permit")) type = "PERMIT";
    else if (title.toLowerCase().contains("insurance")) type = "INSURANCE";
    else if (title.toLowerCase().contains("police")) type = "POLICE";

    try {
      final picker = ImagePicker();
      final XFile? picked = await picker.pickImage(source: ImageSource.gallery, imageQuality: 75);
      if (picked == null) return;
      
      final bytes = await picked.readAsBytes();
      
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("$title selected - Uploading to Supabase..."), duration: Duration(seconds: 2)));
      }

      bool uploaded = false;
      String newUrl = "";
      String lastError = "";
      
      Future<bool> tryUpload(String token, String fieldName) async {
        try {
          var req = http.MultipartRequest('POST', Uri.parse("https://saas-backend-avz2.onrender.com/driver/docs/upload"));
          req.headers['Authorization'] = "Bearer $token";
          req.fields['doc_type'] = type;
          req.fields['driver_id'] = widget.driver['driver_id'].toString();
          req.files.add(http.MultipartFile.fromBytes(fieldName, bytes, filename: picked.name));
          var streamed = await req.send().timeout(Duration(seconds: 30));
          var respStr = await streamed.stream.bytesToString();
          print("upload resp token=${token.substring(0,10)}... field=$fieldName status=${streamed.statusCode} body=${respStr.substring(0, respStr.length > 300 ? 300 : respStr.length)}");
          if (streamed.statusCode == 200 || streamed.statusCode == 201) {
            try {
              var j = json.decode(respStr);
              newUrl = j['url'] ?? "";
            } catch(_){}
            return true;
          } else {
            lastError = "Status ${streamed.statusCode}: $respStr";
            return false;
          }
        } catch (e) {
          lastError = e.toString();
          print("upload fail $e");
          return false;
        }
      }

      // Try JWT with file field
      uploaded = await tryUpload(widget.token, 'file');
      // Try JWT with document field
      if (!uploaded) uploaded = await tryUpload(widget.token, 'document');
      // Try driver_id fallback
      if (!uploaded) uploaded = await tryUpload(widget.driver['driver_id'].toString(), 'file');
      if (!uploaded) uploaded = await tryUpload(widget.driver['driver_id'].toString(), 'document');

      if (mounted) {
        setState(() {
          if (newUrl.isNotEmpty) {
            docUrls[type] = newUrl + "${newUrl.contains("?") ? "&" : "?"}t=${DateTime.now().millisecondsSinceEpoch}";
          }
          docStatus[type] = uploaded ? "PENDING_VERIFICATION" : "UPLOADED_LOCALLY";
        });
      }

      if (uploaded) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("$title uploaded! Fetching new image..."), backgroundColor: Colors.green, duration: Duration(seconds: 2)));
        await Future.delayed(Duration(seconds: 1));
        await _fetchDocs();
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("$title updated in Supabase!"), backgroundColor: Colors.green));
      } else {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Upload failed: $lastError. Showing local preview. Logout/login if token expired."), backgroundColor: Colors.orange, duration: Duration(seconds: 5)));
        setState(() {
          docUrls[type] = picked.path;
        });
      }
    } catch (e) {
      print("picker error $e");
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Error: $e"), backgroundColor: Colors.red));
    }
  }


  Widget _docTile(Map<String, dynamic> doc) {
    final type = doc['type'];
    final title = doc['title'];
    final subtitle = doc['subtitle'];
    final icon = doc['icon'] as IconData;
    final color = doc['color'] as Color;
    final url = docUrls[type];
    final status = docStatus[type] ?? (url != null ? "APPROVED" : "PENDING");
    final hasDoc = url != null && url.isNotEmpty;
    Widget thumb;
    if (hasDoc && url!.startsWith("http")) {
      thumb = Image.network(url, key: ValueKey(url), fit: BoxFit.cover, width: 56, height: 56, errorBuilder: (c,e,s)=> Icon(icon, color: color, size:28));
    } else if (hasDoc && url.startsWith("/")) {
      thumb = Image.file(File(url), fit: BoxFit.cover, width:56, height:56, errorBuilder: (c,e,s)=> Icon(Icons.photo, color: color, size:28));
    } else if (hasDoc) {
      // local picked but not http, show green placeholder
      thumb = Container(color: Colors.green.shade100, width:56, height:56, child: Icon(Icons.photo_library, color: Colors.green, size:28));
    } else {
      thumb = Icon(icon, color: color, size:28);
    }
    return Card(
      margin: EdgeInsets.symmetric(vertical: 6),
      elevation: 2,
      child: ListTile(
        leading: Container(width:56, height:56, decoration: BoxDecoration(color: color.withOpacity(0.15), borderRadius: BorderRadius.circular(8)), child: ClipRRect(borderRadius: BorderRadius.circular(8), child: thumb)),
        title: Text(title, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(subtitle, style: TextStyle(fontSize:11)), SizedBox(height:2), Text(status, style: TextStyle(fontSize:10, color: hasDoc? Colors.green: Colors.orange, fontWeight: FontWeight.bold))]),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.check_circle, color: hasDoc? Colors.green: Colors.grey, size:20), SizedBox(width:8), Icon(Icons.visibility, size:22)]),
        onTap: () => _viewDoc(title, url, status),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text("My Documents")),
      body: loading
          ? Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [CircularProgressIndicator(), SizedBox(height: 12), Text("Fetching from Supabase...")]))
          : RefreshIndicator(
              onRefresh: _fetchDocs,
              child: ListView(
                padding: EdgeInsets.all(16),
                children: [
                  Text("Tap to view full image, re-upload from gallery", style: TextStyle(fontSize: 11, color: Colors.black54)),
                  SizedBox(height: 8),
                  ...allDocs.map((d) => _docTile(d)).toList(),
                  SizedBox(height: 20),
                  Text("Source: Supabase driver_documents bucket • Signed URLs 5min", style: TextStyle(fontSize: 10, color: Colors.black45), textAlign: TextAlign.center),
                ],
              ),
            ),
    );
  }
}
