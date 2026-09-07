import styles from './Header.module.css'

export default function Header() {
  return <header className={styles.header}><div className={styles.title}>video<span className={styles.accent}>loader</span><span className={styles.beta}>BETA</span></div><p className={styles.subtitle}>Любимые видео под рукой</p></header>
}
