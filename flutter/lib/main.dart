import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'firebase_options.dart';
import 'services/api_service.dart';

/// Background message handler — must be top-level function
@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  // Firebase is already initialized by the system in background isolate
  // No UI update possible here — just log
}

class AuthNotifier extends ChangeNotifier {
  bool? _isLoggedIn;
  String _role;
  AuthNotifier(this._isLoggedIn, this._role);

  bool? get isLoggedIn => _isLoggedIn;
  String get role => _role;

  void update(bool value, {String role = ''}) {
    if (_isLoggedIn != value || _role != role) {
      _isLoggedIn = value;
      _role = role;
      notifyListeners();
    }
  }
}

final authNotifier = AuthNotifier(null, '');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  try {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );

    // Set up FCM background handler (mobile only)
    if (!kIsWeb) {
      FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);

      // Request notification permission (iOS + Android 13+)
      await FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
    }
  } catch (_) {
    // Firebase will be unavailable until real config values are filled in
    // firebase_options.dart. Email/password login works without Firebase.
  }

  await ApiService().loadTokens();
  final prefs = await SharedPreferences.getInstance();
  final role = prefs.getString('user_role') ?? '';
  authNotifier.update(ApiService().isLoggedIn, role: role);
  ApiService.onAuthChanged = (value) {
    final role = prefs.getString('user_role') ?? '';
    authNotifier.update(value, role: role);
  };
  runApp(const ProviderScope(child: MyApp()));
}

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {

    return MaterialApp.router(
      title: 'Recurva',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF2196F3),
          brightness: Brightness.light,
        ),
        appBarTheme: const AppBarTheme(
          elevation: 0,
          centerTitle: true,
          backgroundColor: Color(0xFF2196F3),
          foregroundColor: Colors.white,
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color(0xFF2196F3),
            foregroundColor: Colors.white,
            padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
            ),
          ),
        ),
      ),
      routerConfig: AppRoutes.router,
    );
  }
}
