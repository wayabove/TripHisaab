import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCCJPoSmeEHHP1N9U_xfNYSksoDGk6s87c",
  authDomain: "trip-expense-tracker-daea7.firebaseapp.com",
  projectId: "trip-expense-tracker-daea7",
  storageBucket: "trip-expense-tracker-daea7.firebasestorage.app",
  messagingSenderId: "79895352518",
  appId: "1:79895352518:web:aeebafa38686e02bb773c7"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);