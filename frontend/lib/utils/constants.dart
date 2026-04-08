const String apiBaseUrl = String.fromEnvironment(
  'API_URL',
  defaultValue: 'http://localhost:3000/api',
);
const int connectionTimeoutSeconds = 30;
const int receiveTimeoutSeconds = 30;

// Status colors
const Map<String, int> statusColors = {
  'active': 0xFF4CAF50,
  'at_risk': 0xFFFFC107,
  'high_risk': 0xFFF44336,
};

// Task types
const List<String> taskTypes = ['call', 'renewal', 'check_in'];

// Outcomes
const List<String> outcomes = ['called', 'not_reachable', 'coming_tomorrow', 'renewed', 'no_action'];
