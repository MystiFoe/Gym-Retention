import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:sentry_flutter/sentry_flutter.dart';
import 'screens/login_screen.dart';
import 'screens/gym_registration_screen.dart';
import 'screens/forgot_password_screen.dart';
import 'screens/reset_password_screen.dart';
import 'screens/subscription_screen.dart';
import 'screens/owner_dashboard_screen.dart';
import 'screens/members_screen.dart';
import 'screens/tasks_screen.dart';
import 'screens/attendance_screen.dart';
import 'screens/revenue_screen.dart';
import 'screens/trainer_dashboard_screen.dart';
import 'screens/member_dashboard_screen.dart';
import 'screens/trainers_screen.dart';
import 'screens/admin_screen.dart';
import 'screens/otp_screen.dart';
import 'services/api_service.dart';

// Notifies GoRouter when auth state changes so redirect re-evaluates
class AuthNotifier extends ChangeNotifier {
  bool _isLoggedIn;
  AuthNotifier(this._isLoggedIn);

  bool get isLoggedIn => _isLoggedIn;

  void update(bool value) {
    if (_isLoggedIn != value) {
      _isLoggedIn = value;
      notifyListeners();
    }
  }
}

// Global — accessible to GoRouter provider and wired to ApiService
final authNotifier = AuthNotifier(false);

// Sentry DSN is injected at build time: --dart-define=SENTRY_DSN=https://...
// Leave empty in development; set it for production builds.
const _sentryDsn = String.fromEnvironment('SENTRY_DSN', defaultValue: '');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ApiService().loadTokens();
  authNotifier.update(ApiService().isLoggedIn);
  ApiService.onAuthChanged = authNotifier.update;

  if (_sentryDsn.isNotEmpty) {
    await SentryFlutter.init(
      (options) {
        options.dsn = _sentryDsn;
        options.tracesSampleRate = 0.2;
        options.environment = const String.fromEnvironment('APP_ENV', defaultValue: 'production');
      },
      appRunner: () => runApp(
        const ProviderScope(child: MyApp()),
      ),
    );
  } else {
    runApp(const ProviderScope(child: MyApp()));
  }
}

// Routes that do NOT require login
const _publicRoutes = ['/login', '/register', '/forgot-password', '/reset-password', '/admin', '/otp-verify'];

final goRouterProvider = Provider((ref) {
  return GoRouter(
    initialLocation: '/login',
    refreshListenable: authNotifier,
    redirect: (context, state) {
      final loggedIn = authNotifier.isLoggedIn;
      final loc = state.matchedLocation;
      final isPublic = _publicRoutes.any((r) => loc.startsWith(r));

      // Not logged in and trying to access a protected route → send to login
      if (!loggedIn && !isPublic) return '/login';

      // Already logged in and going to /login → stay (let login screen handle redirect)
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: '/register',
        builder: (context, state) => const GymRegistrationScreen(),
      ),
      GoRoute(
        path: '/otp-verify',
        builder: (context, state) => OtpScreen(
          email: state.queryParameters['email'] ?? '',
        ),
      ),
      GoRoute(
        path: '/forgot-password',
        builder: (context, state) => const ForgotPasswordScreen(),
      ),
      GoRoute(
        path: '/reset-password',
        builder: (context, state) => ResetPasswordScreen(
          token: state.queryParameters['token'] ?? '',
        ),
      ),
      GoRoute(
        path: '/subscription',
        builder: (context, state) => const SubscriptionScreen(),
      ),
      GoRoute(
        path: '/owner/dashboard',
        builder: (context, state) => const OwnerDashboardScreen(),
      ),
      GoRoute(
        path: '/owner/members',
        builder: (context, state) => const MembersScreen(),
      ),
      GoRoute(
        path: '/owner/tasks',
        builder: (context, state) => const TasksScreen(),
      ),
      GoRoute(
        path: '/owner/attendance',
        builder: (context, state) => const AttendanceScreen(),
      ),
      GoRoute(
        path: '/owner/revenue',
        builder: (context, state) => const RevenueScreen(),
      ),
      GoRoute(
        path: '/owner/trainers',
        builder: (context, state) => const TrainersScreen(),
      ),
      GoRoute(
        path: '/trainer/dashboard',
        builder: (context, state) => const TrainerDashboardScreen(),
      ),
      GoRoute(
        path: '/member/dashboard',
        builder: (context, state) => const MemberDashboardScreen(),
      ),
      GoRoute(
        path: '/admin',
        builder: (context, state) => const AdminScreen(),
      ),
    ],
  );
});

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final goRouter = ref.watch(goRouterProvider);

    return MaterialApp.router(
      title: 'Gym Retention',
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
      routerConfig: goRouter,
    );
  }
}
