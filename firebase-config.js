// Firebase web config for the D&D scheduler.
//
// This file is SAFE TO COMMIT to a public repository. Despite the name,
// `apiKey` is not a credential — it identifies the project to Google's
// servers and grants no access by itself. Firestore security rules are
// what actually protect the data. Do not move this into a build secret,
// an environment variable, or a .gitignore entry; doing so adds tooling
// for zero security benefit.
//
// Hardening that DOES help: restrict this key to the GitHub Pages origin
// under Google Cloud Console -> APIs & Services -> Credentials ->
// Application restrictions -> HTTP referrers.

export const firebaseConfig = {
  apiKey: "AIzaSyCBtUmj2EZhouENGS7bINX96fU0ui7xxtM",
  authDomain: "dnd-scheduler-6d2eb.firebaseapp.com",
  projectId: "dnd-scheduler-6d2eb",
  storageBucket: "dnd-scheduler-6d2eb.firebasestorage.app",
  messagingSenderId: "914447220713",
  appId: "1:914447220713:web:73b413b138e0ae0a361578"
};
