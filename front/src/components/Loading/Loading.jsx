import styles from "./Loading.module.css"

function Loading() {
  return (
    <div className={styles.loadingBlock}>
      <div className={styles.spinner}></div>
    </div>
  )
}

export default Loading
