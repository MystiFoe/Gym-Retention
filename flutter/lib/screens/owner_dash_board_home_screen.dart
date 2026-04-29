import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:gym_fitness_app/screens/revenue_screen.dart';
import 'package:gym_fitness_app/screens/tasks_screen.dart';

import 'customers_screen.dart';
import 'owner_dashboard_screen.dart';

class OwnerDashBoardHomeScreen extends StatefulWidget {
  const OwnerDashBoardHomeScreen({super.key});

  @override
  State<OwnerDashBoardHomeScreen> createState() =>
      _OwnerDashBoardHomeScreenState();
}
class _OwnerDashBoardHomeScreenState extends State<OwnerDashBoardHomeScreen> {
  int selectedIndex = 0;
  DateTime? _lastBackPress;
  final _triggers = [0, 0, 0, 0];

  List<Widget> get _pages => [
    OwnerDashboardScreen(refreshTrigger: _triggers[0]),
    MembersScreen(refreshTrigger: _triggers[1]),
    TasksScreen(refreshTrigger: _triggers[2]),
    RevenueScreen(refreshTrigger: _triggers[3]),
  ];

  Future<bool> _onBackPressed() async {
    // Not on home tab → switch to home tab
    if (selectedIndex != 0) {
      setState(() => selectedIndex = 0);
      return false;
    }

    // On home tab — double-back within 2 s exits directly
    final now = DateTime.now();
    if (_lastBackPress != null &&
        now.difference(_lastBackPress!) < const Duration(seconds: 2)) {
      return true; // allow exit
    }
    _lastBackPress = now;

    // Single back on home tab → ask to quit
    final exit = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Exit App'),
        content: const Text('Do you want to quit Recurva?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('No'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Yes', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
    if (exit == true) SystemNavigator.pop();
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (!didPop) await _onBackPressed();
      },
      child: Scaffold(
      body: IndexedStack(
        index: selectedIndex,
        children: _pages,
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.05),
              blurRadius: 10,
              offset: const Offset(0, -2),
            ),
          ],
        ),
        child: BottomNavigationBar(
          currentIndex: selectedIndex,
          onTap: (index) {
            setState(() {
              _triggers[index]++;   // refresh data on the tab being switched to
              selectedIndex = index;
            });
          },
          type: BottomNavigationBarType.fixed,
          elevation: 0,
          backgroundColor: Colors.transparent,
          selectedItemColor: Colors.blueAccent,
          unselectedItemColor: Colors.grey.shade500,
          selectedFontSize: 12,
          unselectedFontSize: 11,
          showUnselectedLabels: true,
          items: [
            BottomNavigationBarItem(
              icon: _buildIcon(Icons.home_outlined, 0),
              activeIcon: _buildIcon(Icons.home, 0, isActive: true),
              label: 'Dashboard',
            ),
            BottomNavigationBarItem(
              icon: _buildIcon(Icons.people_outline, 1),
              activeIcon: _buildIcon(Icons.people, 1, isActive: true),
              label: 'Customers',
            ),
            BottomNavigationBarItem(
              icon: _buildIcon(Icons.assignment_outlined, 2),
              activeIcon: _buildIcon(Icons.assignment, 2, isActive: true),
              label: 'Tasks',
            ),
            BottomNavigationBarItem(
              icon: _buildIcon(Icons.trending_up_outlined, 3),
              activeIcon: _buildIcon(Icons.trending_up, 3, isActive: true),
              label: 'Revenue',
            ),
          ],
        ),
      ),
    ),   // Scaffold
    );   // PopScope
  }
}
// class _OwnerDashBoardHomeScreenState
//     extends State<OwnerDashBoardHomeScreen> {
//   int selectedIndex = 0;
//
//   final List<Widget> pages = const [
//     OwnerDashboardScreen(),
//     MembersScreen(),
//     TasksScreen(),
//     RevenueScreen(),
//   ];
//
//   @override
//   Widget build(BuildContext context) {
//     return Scaffold(
//       body: pages[selectedIndex], // ✅ IMPORTANT
//       bottomNavigationBar: Container(
//         decoration: BoxDecoration(
//           color: Colors.white,
//           boxShadow: [
//             BoxShadow(
//               color: Colors.black.withValues(alpha: 0.05),
//               blurRadius: 10,
//               offset: const Offset(0, -2),
//             ),
//           ],
//         ),
//         child: BottomNavigationBar(
//           currentIndex: selectedIndex,
//           onTap: (index) {
//             setState(() {
//               selectedIndex = index;
//             });
//           },
//           type: BottomNavigationBarType.fixed,
//           elevation: 0,
//           backgroundColor: Colors.transparent,
//
//           selectedItemColor: Colors.blueAccent,
//           unselectedItemColor: Colors.grey.shade500,
//
//           selectedFontSize: 12,
//           unselectedFontSize: 11,
//
//           showUnselectedLabels: true,
//
//           items: [
//             BottomNavigationBarItem(
//               icon: _buildIcon(Icons.home_outlined, 0),
//               activeIcon: _buildIcon(Icons.home, 0, isActive: true),
//               label: 'Dashboard',
//             ),
//             BottomNavigationBarItem(
//               icon: _buildIcon(Icons.people_outline, 1),
//               activeIcon: _buildIcon(Icons.people, 1, isActive: true),
//               label: 'Customers',
//             ),
//             BottomNavigationBarItem(
//               icon: _buildIcon(Icons.assignment_outlined, 2),
//               activeIcon: _buildIcon(Icons.assignment, 2, isActive: true),
//               label: 'Tasks',
//             ),
//             BottomNavigationBarItem(
//               icon: _buildIcon(Icons.trending_up_outlined, 3),
//               activeIcon: _buildIcon(Icons.trending_up, 3, isActive: true),
//               label: 'Revenue',
//             ),
//           ],
//         ),
//       ),
//
//       // bottomNavigationBar: BottomNavigationBar(
//       //   currentIndex: selectedIndex,
//       //   onTap: (index) {
//       //     setState(() {
//       //       selectedIndex = index;
//       //     });
//       //   },
//       //   items: const [
//       //     BottomNavigationBarItem(
//       //       icon: Icon(Icons.home, color: Colors.blue),
//       //       label: 'Dashboard',
//       //     ),
//       //     BottomNavigationBarItem(
//       //       icon: Icon(Icons.people, color: Colors.blue),
//       //       label: 'Members',
//       //     ),
//       //     BottomNavigationBarItem(
//       //       icon: Icon(Icons.assignment, color: Colors.blue),
//       //       label: 'Tasks',
//       //     ),
//       //     BottomNavigationBarItem(
//       //       icon: Icon(Icons.trending_up, color: Colors.blue),
//       //       label: 'Revenue',
//       //     ),
//       //   ],
//       // ),
//     );
//   }
// }
Widget _buildIcon(IconData icon, int index, {bool isActive = false}) {
  return AnimatedContainer(
    duration: const Duration(milliseconds: 250),
    padding: const EdgeInsets.all(6),
    decoration: BoxDecoration(
      color: isActive ? Colors.blue.withValues(alpha: 0.1) : Colors.transparent,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Icon(
      icon,
      size: isActive ? 26 : 22,
      color: isActive ? Colors.blueAccent : Colors.grey,
    ),
  );
}
